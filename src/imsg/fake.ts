import { appendFileSync, readFileSync } from "node:fs";
import type { RpcConnector } from "./rpc.ts";

// An in-memory stand-in for `imsg rpc`. It follows the documented JSON-RPC contract closely
// enough for the session to be tested without a Mac: exclusive history `end`, newest-first
// ordering with ROWID ties, reaction snapshots, since_rowid replay, and bridge-only methods.

export type FakeImsgAttachment = { transfer_name: string; mime_type: string; total_bytes: number; original_path?: string; missing?: boolean };
export type FakeImsgReaction = { type: string; emoji?: string; add: boolean; target: string };
export type FakeImsgMessage = {
  id: number; chat_id: number; guid: string; sender: string; sender_name?: string; is_from_me: boolean;
  text: string; created_at: number; attachments?: FakeImsgAttachment[]; reply_to_guid?: string; reaction?: FakeImsgReaction;
  // The message row's own service; defaults to the chat's stored one.
  service?: "iMessage" | "SMS";
};
export type FakeImsgChat = {
  id: number; guid: string; identifier: string; service: "iMessage" | "SMS"; is_group: boolean;
  display_name?: string; contact_name?: string; participants: string[]; unread_count: number;
};
export type FakeImsgFailure = { code: number; message: string; data?: unknown };
export type FakeImsgOptions = {
  bridge?: boolean;
  databaseReady?: boolean;
  chats?: FakeImsgChat[];
  messages?: FakeImsgMessage[];
  failures?: Record<string, FakeImsgFailure>;
  delays?: Record<string, number>;
};
export type FakeImsgRequest = { method: string; params: Record<string, unknown> };

type Subscription = { emit: (line: string) => void; reactions: boolean };
type Reply = { result?: unknown; error?: FakeImsgFailure; after?: () => void };

class FakeError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

const BRIDGE_METHODS = new Set(["tapback", "chats.create", "bridge.events.subscribe"]);

export class FakeImsg {
  bridge: boolean;
  databaseReady: boolean;
  chats: FakeImsgChat[];
  messages: FakeImsgMessage[];
  failures: Map<string, FakeImsgFailure>;
  delays: Map<string, number>;
  requests: FakeImsgRequest[] = [];
  sent: { chat_guid: string; text: string; reply_to?: string }[] = [];
  private readonly subscriptions = new Map<number, Subscription>();
  private nextSubscription = 1;
  private nextRowId: number;

  constructor(options: FakeImsgOptions = {}) {
    const demo = demoData();
    this.bridge = options.bridge ?? false;
    this.databaseReady = options.databaseReady ?? true;
    this.chats = options.chats ?? demo.chats;
    this.messages = options.messages ?? demo.messages;
    this.failures = new Map(Object.entries(options.failures ?? {}));
    this.delays = new Map(Object.entries(options.delays ?? {}));
    this.nextRowId = Math.max(0, ...this.messages.map((message) => message.id)) + 1;
  }

  // An in-process transport; responses arrive asynchronously like pipe reads do.
  connect(): RpcConnector {
    return (events) => {
      let open = true;
      const emit = (line: string) => { if (open) setTimeout(() => { if (open) events.line(line); }, 0); };
      return {
        write: (line) => { void this.handle(line, emit); },
        close: async () => { open = false; this.dropSubscriptions(emit); },
      };
    };
  }

  // Appends a row as Messages would and streams it to watchers.
  deliver(message: Omit<FakeImsgMessage, "id"> & { id?: number }, notify = true): FakeImsgMessage {
    const stored = { ...message, id: message.id ?? this.nextRowId++ };
    this.nextRowId = Math.max(this.nextRowId, stored.id + 1);
    this.messages.push(stored);
    if (!notify) return stored;
    for (const [subscription, watcher] of this.subscriptions) {
      if (stored.reaction && !watcher.reactions) continue;
      watcher.emit(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription, message: this.payload(stored, true) } }));
    }
    return stored;
  }

  // Ends every watch the way imsg does when a subscriber's buffer fills.
  overflow(resumeAfterRowid: number): void {
    for (const [subscription, watcher] of this.subscriptions) {
      watcher.emit(JSON.stringify({ jsonrpc: "2.0", method: "watch.overflow", params: { subscription, resume_after_rowid: resumeAfterRowid, reason: "buffer_limit_exceeded", terminal: true } }));
    }
    this.subscriptions.clear();
  }

  receive(chatId: number, text: string, sender: string, senderName?: string): FakeImsgMessage {
    const chat = this.chat(chatId);
    chat.unread_count += 1;
    return this.deliver({ chat_id: chatId, guid: `in-${this.nextRowId}`, sender, ...(senderName ? { sender_name: senderName } : {}), is_from_me: false, text, created_at: Date.now() });
  }

  async handle(line: string, emit: (line: string) => void): Promise<void> {
    let request: Record<string, unknown>;
    try { request = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = request.id;
    const method = String(request.method ?? "");
    const params = (typeof request.params === "object" && request.params !== null ? request.params : {}) as Record<string, unknown>;
    this.requests.push({ method, params });
    let reply: Reply;
    const failure = this.failures.get(method);
    if (failure) reply = { error: failure };
    else {
      try { reply = this.dispatch(method, params, emit); }
      catch (error) {
        reply = { error: error instanceof FakeError ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } : { code: -32603, message: "Internal error", data: String(error) } };
      }
    }
    if (id === undefined) return;
    // Delays hold the response, not the work: a send's row can stream in before its result.
    const delay = this.delays.get(method);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    emit(JSON.stringify(reply.error ? { jsonrpc: "2.0", id, error: reply.error } : { jsonrpc: "2.0", id, result: reply.result }));
    reply.after?.();
  }

  private dispatch(method: string, params: Record<string, unknown>, emit: (line: string) => void): Reply {
    if (BRIDGE_METHODS.has(method) && !this.bridge) {
      throw new FakeError(-32003, "Bridge unavailable", { detail: "The bridge is not started. Run imsg launch explicitly before using bridge methods.", retryable: true });
    }
    const needsDatabase = ["chats.list", "messages.history", "messages.after", "watch.subscribe"].includes(method);
    if (needsDatabase && !this.databaseReady) {
      throw new FakeError(-32002, "Database unavailable", { path: "/Users/me/Library/Messages/chat.db", detail: "unable to open database file", retryable: true });
    }
    switch (method) {
      case "initialize": case "status": return { result: this.status() };
      case "chats.list": return { result: { chats: this.listChats(Number(params.limit ?? 20)) } };
      case "messages.history": return { result: { messages: this.history(params) } };
      case "watch.subscribe": return this.subscribe(params, emit);
      case "watch.unsubscribe": this.subscriptions.delete(Number(params.subscription)); return { result: { ok: true } };
      case "bridge.events.subscribe": return { result: { subscription: this.nextSubscription++, buffer_limit: 256, resumable: false } };
      case "send": return { result: this.send(params) };
      case "chats.create": return { result: this.createChat(params) };
      case "tapback": return { result: this.tapback(params) };
      case "read": {
        if (!this.bridge) throw new FakeError(-32603, "Internal error", "IMCore read receipts are unavailable");
        const chat = this.chats.find((candidate) => candidate.guid === params.chat_guid);
        if (chat) chat.unread_count = 0;
        return { result: { ok: true } };
      }
      case "typing": return { result: { ok: true } };
      case "message.send_status": {
        // Like imsg, any message row answers, incoming ones included.
        const message = this.messages.find((candidate) => candidate.guid === params.guid);
        if (!message) return { result: { ok: true, guid: params.guid, send_state: "pending", service: null, status_fields: null } };
        const service = message.service ?? this.chat(message.chat_id).service;
        if (!message.is_from_me) return { result: { ok: true, guid: message.guid, send_state: "sent", service, status_fields: { is_sent: false, is_delivered: false, error: 0, date_delivered: null, date_read: null } } };
        const delivered = new Date(message.created_at + 1_000).toISOString();
        return { result: { ok: true, guid: message.guid, send_state: "delivered", service, delivered_at: delivered, status_fields: { is_sent: true, is_delivered: true, error: 0, date_delivered: delivered, date_read: null } } };
      }
      default: throw new FakeError(-32601, "Method not found", method);
    }
  }

  private status(): Record<string, unknown> {
    return {
      version: "0.0.0-fake", protocol_version: 1,
      database: this.databaseReady ? { path: "/Users/me/Library/Messages/chat.db", ready: true } : { path: "/Users/me/Library/Messages/chat.db", ready: false, error: "unable to open database file: authorization denied" },
      bridge: this.bridge ? { ready: true } : { ready: false, error: "The bridge is not started. Run imsg launch explicitly before using bridge methods." },
      contacts: { available: true },
      methods: ["initialize", "status", "chats.list", "messages.history", "watch.subscribe", "watch.unsubscribe", "send", "typing", "read", ...(this.bridge ? ["tapback", "chats.create", "bridge.events.subscribe"] : [])],
    };
  }

  private chat(id: number): FakeImsgChat {
    const chat = this.chats.find((candidate) => candidate.id === id);
    if (!chat) throw new FakeError(-32602, "Invalid params", `unknown chat_id ${id}`);
    return chat;
  }

  private lastActivity(chat: FakeImsgChat): number {
    return Math.max(0, ...this.messages.filter((message) => message.chat_id === chat.id).map((message) => message.created_at));
  }

  private listChats(limit: number): Record<string, unknown>[] {
    return this.chats.toSorted((a, b) => this.lastActivity(b) - this.lastActivity(a)).slice(0, limit).map((chat) => ({
      id: chat.id, name: chat.display_name || chat.contact_name || chat.identifier, display_name: chat.display_name ?? "",
      ...(chat.contact_name ? { contact_name: chat.contact_name } : {}),
      identifier: chat.identifier, guid: chat.guid, service: chat.service,
      last_message_at: new Date(this.lastActivity(chat)).toISOString(), is_group: chat.is_group,
      participants: chat.participants, unread_count: chat.unread_count,
    }));
  }

  private history(params: Record<string, unknown>): Record<string, unknown>[] {
    const chat = this.chat(Number(params.chat_id));
    const end = typeof params.end === "string" ? Date.parse(params.end) : Number.POSITIVE_INFINITY;
    return this.messages
      .filter((message) => message.chat_id === chat.id && !message.reaction && message.created_at < end)
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
      .slice(0, Number(params.limit ?? 50))
      .map((message) => this.payload(message, params.attachments === true));
  }

  private subscribe(params: Record<string, unknown>, emit: (line: string) => void): Reply {
    const subscription = this.nextSubscription++;
    const since = typeof params.since_rowid === "number" ? params.since_rowid : 0;
    const reactions = params.include_reactions === true;
    return {
      result: { subscription, buffer_limit: 256 },
      after: () => {
        this.subscriptions.set(subscription, { emit, reactions });
        if (since === 0) return;
        for (const message of this.messages.filter((row) => row.id > since && (reactions || !row.reaction)).sort((a, b) => a.id - b.id)) {
          emit(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription, message: this.payload(message, true) } }));
        }
      },
    };
  }

  private target(params: Record<string, unknown>): FakeImsgChat {
    if (typeof params.chat_guid === "string") {
      const chat = this.chats.find((candidate) => candidate.guid === params.chat_guid);
      if (!chat) throw new FakeError(-32602, "Invalid params", `unknown chat_guid ${params.chat_guid}`);
      return chat;
    }
    if (typeof params.chat_id === "number") return this.chat(params.chat_id);
    const to = String(params.to ?? "");
    if (!to) throw new FakeError(-32602, "Invalid params", "to or a chat target is required");
    const existing = this.chats.find((candidate) => !candidate.is_group && candidate.identifier === to);
    if (existing) return existing;
    const service = params.service === "sms" ? "SMS" : "iMessage";
    const chat: FakeImsgChat = { id: Math.max(0, ...this.chats.map((candidate) => candidate.id)) + 1, guid: `${service};-;${to}`, identifier: to, service, is_group: false, participants: [to], unread_count: 0 };
    this.chats.push(chat);
    return chat;
  }

  private send(params: Record<string, unknown>): Record<string, unknown> {
    const text = String(params.text ?? "");
    if (!text) throw new FakeError(-32602, "Invalid params", "text or file is required");
    if (params.reply_to !== undefined && !this.bridge) throw new FakeError(-32003, "Bridge unavailable", { detail: "Replies require the imsg bridge.", retryable: true });
    const chat = this.target(params);
    // Messages carries on over the service the conversation last used.
    const service = this.messages.filter((row) => row.chat_id === chat.id && !row.reaction).toSorted((a, b) => b.created_at - a.created_at || b.id - a.id)[0]?.service ?? chat.service;
    const message = this.deliver({
      chat_id: chat.id, guid: `sent-${this.nextRowId}`, sender: chat.is_group ? "" : chat.identifier, is_from_me: true, text, created_at: Date.now(), service,
      ...(typeof params.reply_to === "string" ? { reply_to_guid: params.reply_to } : {}),
    });
    this.sent.push({ chat_guid: chat.guid, text, ...(typeof params.reply_to === "string" ? { reply_to: params.reply_to } : {}) });
    return { ok: true, transport: "applescript", id: message.id, guid: message.guid, chat_guid: chat.guid, service };
  }

  private createChat(params: Record<string, unknown>): Record<string, unknown> {
    const addresses = Array.isArray(params.addresses) ? params.addresses.map(String) : [];
    const chat: FakeImsgChat = { id: Math.max(0, ...this.chats.map((candidate) => candidate.id)) + 1, guid: `iMessage;+;chat${Date.now()}`, identifier: `chat${Date.now()}`, service: "iMessage", is_group: true, participants: addresses, unread_count: 0 };
    this.chats.push(chat);
    const text = String(params.text ?? "");
    if (!text) return { ok: true, chat_guid: chat.guid };
    const message = this.deliver({ chat_id: chat.id, guid: `sent-${this.nextRowId}`, sender: "", is_from_me: true, text, created_at: Date.now() });
    this.sent.push({ chat_guid: chat.guid, text });
    return { ok: true, chat_guid: chat.guid, guid: message.guid };
  }

  private tapback(params: Record<string, unknown>): Record<string, unknown> {
    const chat = this.target(params);
    const target = String(params.message_guid ?? "");
    this.deliver({ chat_id: chat.id, guid: `tapback-${this.nextRowId}`, sender: "", is_from_me: true, text: "", created_at: Date.now(), reaction: { type: String(params.reaction), add: params.remove !== true, target } });
    return { ok: true, reaction: params.reaction };
  }

  private reactionsFor(guid: string): Record<string, unknown>[] {
    const current = new Map<string, FakeImsgMessage>();
    for (const row of this.messages.filter((message) => message.reaction?.target === guid).sort((a, b) => a.created_at - b.created_at || a.id - b.id)) {
      const key = `${row.is_from_me ? "me" : row.sender}|${row.reaction!.type}|${row.reaction!.emoji ?? ""}`;
      if (row.reaction!.add) current.set(key, row);
      else current.delete(key);
    }
    return [...current.values()].map((row) => ({
      id: row.id, type: row.reaction!.type, emoji: row.reaction!.emoji ?? "", sender: row.sender,
      ...(row.sender_name ? { sender_name: row.sender_name } : {}), is_from_me: row.is_from_me, created_at: new Date(row.created_at).toISOString(),
    }));
  }

  private payload(message: FakeImsgMessage, attachments: boolean): Record<string, unknown> {
    const chat = this.chat(message.chat_id);
    const base: Record<string, unknown> = {
      id: message.id, chat_id: chat.id, chat_identifier: chat.identifier, chat_guid: chat.guid, chat_name: chat.display_name || chat.contact_name || chat.identifier,
      participants: chat.participants, is_group: chat.is_group, guid: message.guid, sender: message.sender,
      ...(message.sender_name ? { sender_name: message.sender_name } : {}),
      is_from_me: message.is_from_me, text: message.text, created_at: new Date(message.created_at).toISOString(),
      attachments: attachments ? (message.attachments ?? []).map((attachment) => ({ filename: attachment.transfer_name, uti: "public.data", is_sticker: false, missing: attachment.missing ?? !attachment.original_path, original_path: attachment.original_path ?? "", ...attachment })) : [],
      reactions: message.reaction ? [] : this.reactionsFor(message.guid),
      ...(message.reply_to_guid ? { reply_to_guid: message.reply_to_guid } : {}),
      ...(message.is_from_me ? {} : { is_read: false }),
    };
    if (message.reaction) {
      Object.assign(base, { is_reaction: true, reaction_type: message.reaction.type, ...(message.reaction.emoji ? { reaction_emoji: message.reaction.emoji } : {}), is_reaction_add: message.reaction.add, reacted_to_guid: message.reaction.target });
    }
    return base;
  }

  private dropSubscriptions(emit: (line: string) => void): void {
    for (const [id, subscription] of this.subscriptions) if (subscription.emit === emit) this.subscriptions.delete(id);
  }
}

// Serves the fake over this process's stdin/stdout, the way `imsg rpc` runs as a child.
// TUIMSG_FAKE_FIXTURE seeds data from JSON; TUIMSG_FAKE_LOG appends every request as NDJSON.
export function runFakeImsgRpc(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options: FakeImsgOptions = env.TUIMSG_FAKE_FIXTURE ? JSON.parse(readFileSync(env.TUIMSG_FAKE_FIXTURE, "utf8")) as FakeImsgOptions : {};
  const fake = new FakeImsg(options);
  const log = env.TUIMSG_FAKE_LOG;
  const emit = (line: string) => { process.stdout.write(`${line}\n`); };
  let buffered = "";
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          if (log) appendFileSync(log, `${line}\n`);
          void fake.handle(line, emit);
        }
        newline = buffered.indexOf("\n");
      }
    });
    process.stdin.on("end", () => resolve());
  });
}

function demoData(): { chats: FakeImsgChat[]; messages: FakeImsgMessage[] } {
  const now = Date.now();
  const jane = "+15551230001";
  const sam = "+15551230002";
  const alex = "+15551230003";
  return {
    chats: [
      { id: 1, guid: `iMessage;-;${jane}`, identifier: jane, service: "iMessage", is_group: false, contact_name: "Jane Doe", participants: [jane], unread_count: 1 },
      { id: 2, guid: `SMS;-;${sam}`, identifier: sam, service: "SMS", is_group: false, contact_name: "Sam Park", participants: [sam], unread_count: 0 },
      { id: 3, guid: "iMessage;+;chat000111222", identifier: "chat000111222", service: "iMessage", is_group: true, display_name: "Weekend", participants: [jane, alex], unread_count: 0 },
    ],
    messages: [
      { id: 1, chat_id: 3, guid: "m3", sender: alex, sender_name: "Alex Kim", is_from_me: false, text: "Bring chips", created_at: now - 86_400_000 },
      { id: 2, chat_id: 2, guid: "m2", sender: sam, is_from_me: true, text: "Parking is around back", created_at: now - 3_600_000 },
      { id: 3, chat_id: 1, guid: "m0", sender: jane, sender_name: "Jane Doe", is_from_me: false, text: "Hey", created_at: now - 300_000 },
      { id: 4, chat_id: 1, guid: "m1", sender: jane, sender_name: "Jane Doe", is_from_me: false, text: "You coming tonight?", created_at: now - 120_000 },
      { id: 5, chat_id: 1, guid: "r5", sender: jane, is_from_me: true, text: "", created_at: now - 100_000, reaction: { type: "love", add: true, target: "m0" } },
    ],
  };
}
