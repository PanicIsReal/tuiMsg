import type { ChatGuid, MessageGuid } from "../domain/ids.ts";
import { parseChatGuid, parseMessageGuid } from "../domain/ids.ts";
import type { Chat, Contact, Reaction, Service } from "../domain/model.ts";
import { cleanLine } from "../domain/text.ts";
import { parseChat, parseMessageRecord, parseService, parseStatus, type ImsgStatus, type ParsedRecord } from "./parse.ts";
import { ImsgMissingError, RpcClosedError, RpcConnection, RpcError, RpcNotSentError, RpcTimeoutError } from "./rpc.ts";

export type BackendErrorKind = "missing" | "access" | "unsupported" | "invalid" | "failed" | "blocked" | "stopped";

// `ambiguous` means the operation may already have happened; never retry it automatically.
export class BackendError extends Error {
  constructor(readonly kind: BackendErrorKind, message: string, readonly ambiguous = false) {
    super(message);
    this.name = "BackendError";
  }
}

const READ_TIMEOUT_MS = 30_000;
// AppleScript sends wait for Messages to record the row, and mutations queue behind each other.
const SEND_TIMEOUT_MS = 90_000;

export type HistoryPage = { records: ParsedRecord[]; count: number };

export class ImsgClient {
  constructor(private readonly rpc: RpcConnection) {}

  async status(): Promise<ImsgStatus> {
    return parseStatus(await this.call("status", {}, 10_000));
  }

  async chats(limit: number): Promise<{ chats: Chat[]; contacts: Contact[] }> {
    const result = await this.call("chats.list", { limit });
    const chats: Chat[] = [];
    const contacts: Contact[] = [];
    for (const entry of arrayField(result, "chats")) {
      try {
        const parsed = parseChat(entry);
        chats.push(parsed.chat);
        contacts.push(...parsed.contacts);
      } catch { /* skip malformed rows */ }
    }
    return { chats, contacts };
  }

  // Newest first; `before` is an exclusive bound, so the oldest message of one page
  // is the cursor for the next.
  async history(chatId: number, options: { limit: number; before?: number }): Promise<HistoryPage> {
    const result = await this.call("messages.history", {
      chat_id: chatId, limit: options.limit, attachments: true,
      ...(options.before !== undefined ? { end: new Date(options.before).toISOString() } : {}),
    });
    const raw = arrayField(result, "messages");
    return { records: parseRecords(raw), count: raw.length };
  }

  async subscribe(sinceRowid: number | undefined): Promise<number> {
    const result = await this.call("watch.subscribe", {
      attachments: true, include_reactions: true, debounce_ms: 250,
      ...(sinceRowid !== undefined ? { since_rowid: sinceRowid } : {}),
    });
    return numberField(result, "subscription");
  }

  async subscribeBridgeEvents(): Promise<number> {
    return numberField(await this.call("bridge.events.subscribe", {}), "subscription");
  }

  async sendText(args: { chatGuid: ChatGuid; text: string; replyTo?: MessageGuid }): Promise<{ guid?: MessageGuid }> {
    const result = await this.mutate("send", { chat_guid: args.chatGuid, text: args.text, ...(args.replyTo ? { reply_to: args.replyTo } : {}) });
    const guid = stringField(result, "guid");
    return guid ? { guid: parseMessageGuid(guid) } : {};
  }

  async sendDirect(args: { to: string; text: string; service: Service }): Promise<{ guid?: MessageGuid; chatGuid?: ChatGuid }> {
    const result = await this.mutate("send", { to: args.to, text: args.text, service: args.service === "SMS" ? "sms" : "imessage" });
    return sendResult(result);
  }

  async createChat(args: { addresses: string[]; text: string }): Promise<{ guid?: MessageGuid; chatGuid?: ChatGuid }> {
    return sendResult(await this.mutate("chats.create", { addresses: args.addresses, text: args.text }));
  }

  async tapback(args: { chatGuid: ChatGuid; messageGuid: MessageGuid; reaction: Reaction; remove: boolean }): Promise<void> {
    await this.mutate("tapback", {
      chat_guid: args.chatGuid, message_guid: args.messageGuid,
      reaction: args.reaction === "emphasize" ? "emphasis" : args.reaction, remove: args.remove,
    });
  }

  // Message rows carry no delivery state or service, so both are looked up per GUID. The
  // lookup works for any message, not only outgoing ones.
  async sendStatus(guid: MessageGuid): Promise<{ state: string; deliveredAt?: number; readAt?: number; service?: Service }> {
    const result = await this.call("message.send_status", { guid });
    const fields = typeof result === "object" && result !== null ? (result as Record<string, unknown>).status_fields : undefined;
    const deliveredAt = Date.parse(stringField(result, "delivered_at") ?? "");
    const readAt = Date.parse(stringField(fields, "date_read") ?? "");
    const service = stringField(result, "service");
    return {
      state: stringField(result, "send_state") ?? "pending",
      ...(Number.isFinite(deliveredAt) ? { deliveredAt } : {}),
      ...(Number.isFinite(readAt) ? { readAt } : {}),
      ...(service ? { service: parseService(service) } : {}),
    };
  }

  async markRead(chatGuid: ChatGuid): Promise<void> {
    await this.mutate("read", { chat_guid: chatGuid });
  }

  async typing(chatGuid: ChatGuid, typing: boolean): Promise<void> {
    await this.mutate("typing", { chat_guid: chatGuid, typing });
  }

  close(): Promise<void> {
    return this.rpc.close();
  }

  private mutate(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.call(method, params, SEND_TIMEOUT_MS, true);
  }

  private async call(method: string, params: Record<string, unknown>, timeoutMs = READ_TIMEOUT_MS, mutation = false): Promise<unknown> {
    try {
      return await this.rpc.request<unknown>(method, params, timeoutMs);
    } catch (error) {
      throw backendError(error, mutation);
    }
  }
}

export function backendError(error: unknown, mutation: boolean): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof ImsgMissingError) return new BackendError("missing", error.message);
  if (error instanceof RpcTimeoutError) return new BackendError("failed", mutation ? `${error.message}. It may still be sent.` : error.message, mutation);
  if (error instanceof RpcNotSentError) return new BackendError("stopped", error.message);
  if (error instanceof RpcClosedError) return new BackendError("stopped", error.message, mutation);
  if (error instanceof RpcError) {
    const data = typeof error.data === "object" && error.data !== null ? error.data as Record<string, unknown> : undefined;
    const detail = typeof error.data === "string" ? error.data : typeof data?.detail === "string" ? data.detail : undefined;
    const message = cleanLine(detail ? `${error.message}: ${detail}` : error.message);
    switch (error.code) {
      case -32002: return new BackendError("access", message);
      case -32003: case -32601: return new BackendError("unsupported", message);
      case -32602: return new BackendError("invalid", message);
      case -32001: return new BackendError("failed", message, true);
      case -32004: return new BackendError("blocked", message);
      default: return new BackendError("failed", message, mutation && typeof data?.disposition === "string" && data.disposition !== "not_started");
    }
  }
  return new BackendError("failed", error instanceof Error ? error.message : String(error), mutation);
}

function parseRecords(raw: unknown[]): ParsedRecord[] {
  return raw.flatMap((entry) => {
    try { return [parseMessageRecord(entry)]; } catch { return []; }
  });
}

function sendResult(result: unknown): { guid?: MessageGuid; chatGuid?: ChatGuid } {
  const guid = stringField(result, "guid") ?? stringField(result, "message_id");
  const chatGuid = stringField(result, "chat_guid");
  let chat: ChatGuid | undefined;
  try { chat = chatGuid ? parseChatGuid(chatGuid) : undefined; } catch { chat = undefined; }
  return { ...(guid ? { guid: parseMessageGuid(guid) } : {}), ...(chat ? { chatGuid: chat } : {}) };
}

function arrayField(value: unknown, key: string): unknown[] {
  const field = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(field) ? field : [];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number {
  const field = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  if (typeof field !== "number") throw new BackendError("invalid", `imsg response is missing ${key}`);
  return field;
}
