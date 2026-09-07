import {
  encodeChatPath,
  type ChatGuid,
  type MessageGuid,
} from "../domain/ids.ts";
import {
  parseChat,
  parseChatList,
  parseContactList,
  parseMessage,
  parseMessageList,
  parseServerInfo,
} from "../domain/parse.ts";
import type {
  Attachment,
  Capabilities,
  Chat,
  ChatPage,
  Contact,
  HistoryCursor,
  Message,
  MessagePage,
  Reaction,
  Service,
} from "../domain/model.ts";

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type BbConfig = {
  url: string;
  password: string;
  fetch?: FetchFn;
  timeoutMs?: number;
};
type Envelope = {
  status?: number;
  message?: string;
  data?: unknown;
  metadata?: { count?: number; total?: number };
  error?: { error?: string } | string;
};
export type BbErrorKind =
  | "auth"
  | "network"
  | "server"
  | "invalid"
  | "unsupported";
export class BbError extends Error {
  constructor(
    readonly kind: BbErrorKind,
    message: string,
    readonly ambiguous = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BbError";
  }
}

type ActiveRequest = {
  controller: AbortController;
  reject: (error: BbError) => void;
  ambiguous: boolean;
};

function makeUrl(base: string, path: string, password: string): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set("password", password);
  return url.toString();
}
function safeRequest(method: string, href: string): string {
  const url = new URL(href);
  return `${method} ${url.origin}${url.pathname}`;
}
function sanitize(value: string, password: string): string {
  return value
    .replaceAll(password, "REDACTED")
    .replace(/password=[^&\s]+/gi, "password=REDACTED");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new BbError("invalid", `invalid ${name} in response`);
  return value;
}
function parseEnvelope(value: unknown, responseStatus: number): Envelope {
  if (!isRecord(value))
    throw new BbError("invalid", "invalid response envelope");
  const status = optionalNumber(value.status, "status") ?? responseStatus;
  if (value.message !== undefined && typeof value.message !== "string")
    throw new BbError("invalid", "invalid message in response");
  let error: Envelope["error"];
  if (typeof value.error === "string") error = value.error;
  else if (value.error !== undefined) {
    if (
      !isRecord(value.error) ||
      (value.error.error !== undefined && typeof value.error.error !== "string")
    )
      throw new BbError("invalid", "invalid error in response");
    error =
      typeof value.error.error === "string" ? { error: value.error.error } : {};
  }
  let metadata: Envelope["metadata"];
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata))
      throw new BbError("invalid", "invalid metadata in response");
    const count = optionalNumber(value.metadata.count, "metadata.count");
    const total = optionalNumber(value.metadata.total, "metadata.total");
    metadata = {
      ...(count === undefined ? {} : { count }),
      ...(total === undefined ? {} : { total }),
    };
  }
  return {
    status,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
    ...(metadata ? { metadata } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
function detail(e: Envelope, fallback: string): string {
  return typeof e.error === "string"
    ? e.error
    : (e.error?.error ?? e.message ?? fallback);
}
function classify(status: number): BbErrorKind {
  if (status === 401 || status === 403) return "auth";
  if ([404, 405, 501].includes(status)) return "unsupported";
  if (status >= 500) return "server";
  return "invalid";
}
function messageFrom(value: unknown, ambiguous = false): Message {
  try {
    const parsed = parseMessage(value);
    if (parsed) return parsed;
  } catch (error) {
    throw new BbError(
      "invalid",
      `invalid message response: ${error instanceof Error ? error.message : String(error)}`,
      ambiguous,
    );
  }
  throw new BbError("invalid", "invalid message response", ambiguous);
}

export class BbClient {
  readonly url: string;
  privateApi = false;
  helperConnected = false;
  private readonly password: string;
  private readonly fetchImpl: FetchFn;
  private readonly timeoutMs: number;
  private readonly active = new Set<ActiveRequest>();
  private closed = false;
  constructor(config: BbConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.password = config.password;
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }
  private async request(
    method: string,
    path: string,
    body?: unknown,
    binary = false,
  ): Promise<Envelope | Uint8Array> {
    if (this.closed)
      throw new BbError(
        "network",
        "BlueBubbles client is closed",
        method !== "GET",
      );
    const href = makeUrl(this.url, path, this.password);
    const controller = new AbortController();
    let rejectRequest!: (error: BbError) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectRequest = reject;
    });
    const active: ActiveRequest = {
      controller,
      reject: rejectRequest,
      ambiguous: method !== "GET",
    };
    this.active.add(active);
    const timer = setTimeout(() => {
      controller.abort();
      rejectRequest(
        new BbError(
          "network",
          `${safeRequest(method, href)} failed: request timed out`,
          method !== "GET",
        ),
      );
    }, this.timeoutMs);
    const init: RequestInit = { method, signal: controller.signal };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    try {
      const response = await Promise.race([
        this.fetchImpl(href, init),
        cancelled,
      ]);
      if (binary && response.ok) {
        const body = await Promise.race([response.arrayBuffer(), cancelled]);
        return new Uint8Array(body);
      }
      const text = await Promise.race([response.text(), cancelled]);
      let envelope: Envelope = { status: response.status };
      if (text) {
        let raw: unknown;
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          throw new BbError(
            "invalid",
            `${safeRequest(method, href)} returned invalid JSON`,
            method !== "GET",
            response.status,
          );
        }
        try {
          envelope = parseEnvelope(raw, response.status);
        } catch {
          throw new BbError("invalid", `${safeRequest(method, href)} returned an invalid response envelope`, method !== "GET", response.status);
        }
      }
      const status = response.ok ? envelope.status ?? response.status : response.status;
      if (!response.ok || status >= 400) {
        const message = sanitize(
          detail(envelope, response.statusText),
          this.password,
        );
        throw new BbError(
          classify(status),
          `${safeRequest(method, href)} failed: ${message}`,
          method !== "GET" && status >= 500,
          status,
        );
      }
      return envelope;
    } catch (error) {
      if (error instanceof BbError) throw error;
      const raw = error instanceof Error ? error.message : String(error);
      const sanitized = sanitize(raw, this.password);
      throw new BbError(
        "network",
        `${safeRequest(method, href)} failed: ${controller.signal.aborted ? "request timed out" : sanitized}`,
        method !== "GET",
      );
    } finally {
      clearTimeout(timer);
      this.active.delete(active);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.active) {
      request.controller.abort();
      request.reject(
        new BbError(
          "network",
          "BlueBubbles client is closed",
          request.ambiguous,
        ),
      );
    }
    this.active.clear();
  }
  private json(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Envelope> {
    return this.request(method, path, body) as Promise<Envelope>;
  }
  private requirePrivate(): void {
    if (!(this.privateApi && this.helperConnected))
      throw new BbError(
        "unsupported",
        "BlueBubbles Private API helper is unavailable",
      );
  }
  async ping(): Promise<boolean> {
    const e = await this.json("GET", "/api/v1/ping");
    return e.status === 200 || e.data === "pong";
  }
  async serverInfo(): Promise<Capabilities> {
    const info = parseServerInfo(await this.json("GET", "/api/v1/server/info"));
    this.privateApi = info.privateApi;
    this.helperConnected = info.helperConnected;
    return info;
  }
  async listChats(
    options: { offset?: number; limit?: number; guid?: ChatGuid } = {},
  ): Promise<ChatPage> {
    const offset = options.offset ?? 0,
      limit = options.limit ?? 200;
    const e = await this.json("POST", "/api/v1/chat/query", {
      offset,
      limit,
      ...(options.guid ? { guid: options.guid } : {}),
      with: ["lastMessage", "participants"],
      sort: "lastmessage",
    });
    const chats = parseChatList(e);
    const count = e.metadata?.count ?? chats.length,
      total = e.metadata?.total ?? count;
    if (count === 0 && offset < total) throw new BbError("invalid", "Conversation pagination made no progress");
    return {
      chats,
      nextOffset: offset + count < total ? offset + count : null,
    };
  }
  async listMessages(
    chatGuid: ChatGuid,
    options: { cursor?: HistoryCursor; limit?: number } = {},
  ): Promise<MessagePage> {
    const limit = options.limit ?? 100,
      offset = options.cursor?.offset ?? 0,
      before = options.cursor?.before ?? Date.now();
    const q = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      before: String(before),
      sort: "DESC",
      with: "attachments",
    });
    const e = await this.json(
      "GET",
      `/api/v1/chat/${encodeChatPath(chatGuid)}/message?${q}`,
    );
    const descending = parseMessageList(e);
    const messages = descending
      .slice()
      .sort((a, b) => a.sentAt - b.sentAt || a.guid.localeCompare(b.guid));
    const count = e.metadata?.count ?? descending.length,
      total = e.metadata?.total ?? count,
      oldest = descending.at(-1)?.sentAt,
      tied =
        oldest === undefined
          ? 0
          : descending.filter((m) => m.sentAt === oldest).length,
      nextOffset = oldest === before ? offset + tied : tied;
    return {
      messages,
      total,
      next:
        offset + count < total && oldest !== undefined
          ? { before: oldest, offset: nextOffset }
          : null,
    };
  }
  async messagesSince(options: {
    after: number;
    before: number;
    offset?: number;
    limit?: number;
  }): Promise<{ messages: Message[]; nextOffset: number | null }> {
    const offset = options.offset ?? 0,
      limit = options.limit ?? 200;
    const e = await this.json("POST", "/api/v1/message/query", {
      ...options,
      offset,
      limit,
      sort: "ASC",
      with: ["attachments"],
    });
    const messages = parseMessageList(e),
      count = e.metadata?.count ?? messages.length,
      total = e.metadata?.total ?? count;
    if (count === 0 && offset < total) throw new BbError("invalid", "Message pagination made no progress");
    return {
      messages,
      nextOffset: offset + count < total ? offset + count : null,
    };
  }
  async sendText(args: {
    chatGuid: ChatGuid;
    message: string;
    tempGuid: string;
    replyTo?: MessageGuid;
  }): Promise<Message> {
    const privateMethod = args.replyTo !== undefined;
    if (privateMethod) this.requirePrivate();
    const e = await this.json("POST", "/api/v1/message/text", {
      chatGuid: args.chatGuid,
      message: args.message,
      tempGuid: args.tempGuid,
      method: privateMethod ? "private-api" : "apple-script",
      ...(args.replyTo ? { selectedMessageGuid: args.replyTo } : {}),
    });
    return messageFrom(e.data, true);
  }
  async createChat(args: {
    addresses: string[];
    message: string;
    service: Service;
    tempGuid: string;
  }): Promise<{ chat: Chat; messages: Message[] }> {
    if (!args.addresses.length || !args.message)
      throw new BbError(
        "invalid",
        "a recipient and first message are required",
      );
    const method =
      this.privateApi && this.helperConnected ? "private-api" : "apple-script";
    const e = await this.json("POST", "/api/v1/chat/new", { ...args, method });
    try {
      const chat = parseChat(e.data);
      const raw = e.data as Record<string, unknown>;
      return { chat, messages: parseMessageList(raw.messages ?? []) };
    } catch {
      throw new BbError("invalid", "BlueBubbles returned an invalid new conversation response; delivery is uncertain", true);
    }
  }
  async queryContacts(addresses: string[]): Promise<Contact[]> {
    return parseContactList(
      await this.json("POST", "/api/v1/contact/query", { addresses }),
    );
  }
  async markRead(guid: ChatGuid): Promise<void> {
    this.requirePrivate();
    await this.json("POST", `/api/v1/chat/${encodeChatPath(guid)}/read`, {});
  }
  async startTyping(guid: ChatGuid): Promise<void> {
    this.requirePrivate();
    await this.json("POST", `/api/v1/chat/${encodeChatPath(guid)}/typing`, {});
  }
  async stopTyping(guid: ChatGuid): Promise<void> {
    this.requirePrivate();
    await this.json(
      "DELETE",
      `/api/v1/chat/${encodeChatPath(guid)}/typing`,
      {},
    );
  }
  async sendReaction(args: {
    chatGuid: ChatGuid;
    messageGuid: MessageGuid;
    reaction: Reaction;
    remove: boolean;
  }): Promise<Message | undefined> {
    this.requirePrivate();
    const e = await this.json("POST", "/api/v1/message/react", {
      chatGuid: args.chatGuid,
      selectedMessageGuid: args.messageGuid,
      reaction: `${args.remove ? "-" : ""}${args.reaction}`,
    });
    return e.data ? messageFrom(e.data) : undefined;
  }
  async previewAttachment(attachment: Attachment): Promise<Uint8Array> {
    return this.request("GET", `/api/v1/attachment/${encodeURIComponent(attachment.guid)}/download?original=false&width=960&quality=good&force=false`, undefined, true) as Promise<Uint8Array>;
  }
  async downloadAttachment(a: Attachment): Promise<Uint8Array> {
    return this.request(
      "GET",
      `/api/v1/attachment/${encodeURIComponent(a.guid)}/download?original=true`,
      undefined,
      true,
    ) as Promise<Uint8Array>;
  }
}
