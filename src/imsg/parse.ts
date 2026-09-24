import { parseChatGuid, parseHandleAddress, parseMessageGuid, type ChatGuid } from "../domain/ids.ts";
import { serviceOfChatGuid, type Attachment, type Chat, type Contact, type Handle, type Message, type Service, type TapbackKind, type TapbackMessage, type TextMessage } from "../domain/model.ts";
import { cleanLine, cleanText } from "../domain/text.ts";

// Maps the JSON documented at https://imsg.sh/json and https://imsg.sh/rpc into domain types.

export type ImsgStatus = {
  version: string;
  databaseReady: boolean;
  databaseError: string | null;
  bridgeReady: boolean;
  methods: string[];
};

export type ParsedRecord = {
  rowId: number | undefined;
  chatGuid: ChatGuid;
  messages: Message[];
  contacts: Contact[];
};

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function time(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error("invalid timestamp");
  return parsed;
}

export function parseService(value: unknown): Service {
  const raw = str(value)?.toLowerCase();
  return raw === "sms" || raw === "rcs" ? "SMS" : "iMessage";
}

// Messages tapback targets can carry a part prefix such as p:0/GUID or bp:GUID.
export function stripPart(guid: string): string {
  return guid.replace(/^(?:p:\d+\/|bp:)/, "");
}

function contactFor(address: string, name: string | undefined): Contact | undefined {
  const displayName = name ? cleanLine(name).trim() : "";
  if (!displayName || !address) return undefined;
  const handle = parseHandleAddress(address);
  return address.includes("@") ? { displayName, phones: [], emails: [handle] } : { displayName, phones: [handle], emails: [] };
}

function handle(address: string, fromMe: boolean, service: Service, name: string | undefined): Handle {
  const resolved = cleanLine(address) || (fromMe ? "me" : "unknown");
  const contact = fromMe ? undefined : contactFor(resolved, name);
  return { address: parseHandleAddress(resolved), service, ...(contact ? { contact } : {}) };
}

export function parseStatus(value: unknown): ImsgStatus {
  if (!isRecord(value)) throw new Error("imsg status must be an object");
  const database = isRecord(value.database) ? value.database : {};
  const bridge = isRecord(value.bridge) ? value.bridge : {};
  return {
    version: str(value.version) ?? "unknown",
    databaseReady: database.ready === true,
    databaseError: str(database.error) ?? null,
    bridgeReady: bridge.ready === true,
    methods: Array.isArray(value.methods) ? value.methods.filter((method): method is string => typeof method === "string") : [],
  };
}

export function parseChat(value: unknown): { chat: Chat; contacts: Contact[] } {
  if (!isRecord(value)) throw new Error("chat must be an object");
  const rowId = num(value.id);
  if (rowId === undefined) throw new Error("chat is missing its id");
  const stored = parseService(value.service);
  const identifier = str(value.identifier) ?? "";
  const isGroup = value.is_group === true;
  const rawGuid = str(value.guid) || `${stored};${isGroup ? "+" : "-"};${identifier}`;
  const guid = parseChatGuid(rawGuid);
  // The row's service_name is only a first guess for a merged (any;) conversation; the
  // session replaces it with the service of the newest message.
  const service = serviceOfChatGuid(rawGuid) ?? stored;
  const addresses = Array.isArray(value.participants) ? value.participants.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
  if (!isGroup && addresses.length === 0 && identifier) addresses.push(identifier);
  const contactName = str(value.contact_name);
  const participants = addresses.map((address, index) => handle(address, false, service, !isGroup && index === 0 ? contactName : undefined));
  const displayName = cleanLine(str(value.display_name) ?? "").trim();
  const title = displayName
    || (isGroup ? participants.map((participant) => participant.address).join(", ") : participants[0]?.contact?.displayName ?? participants[0]?.address)
    || cleanLine(str(value.name) ?? identifier)
    || "Unknown";
  const lastActivity = typeof value.last_message_at === "string" ? Date.parse(value.last_message_at) : Number.NaN;
  const chat: Chat = {
    guid, kind: isGroup ? "group" : "dm", service, title, participants,
    unreadCount: num(value.unread_count) ?? 0, muted: false, rowId,
    ...(Number.isFinite(lastActivity) ? { lastActivityAt: lastActivity } : {}),
  };
  return { chat, contacts: participants.flatMap((participant) => participant.contact ? [participant.contact] : []) };
}

function tapbackKind(type: unknown, emoji: unknown): { reaction: TapbackKind; emoji?: string } | undefined {
  switch (str(type)) {
    case "love": case "like": case "dislike": case "laugh": case "question": return { reaction: str(type) as TapbackKind };
    case "emphasis": case "emphasize": return { reaction: "emphasize" };
    default: {
      const glyph = cleanLine(str(emoji) ?? "");
      return glyph ? { reaction: "emoji", emoji: glyph } : undefined;
    }
  }
}

function parseAttachments(value: unknown, message: string): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const path = str(entry.original_path);
    const name = cleanLine(str(entry.transfer_name) || str(entry.filename)?.split("/").at(-1) || "attachment");
    return [{
      guid: `${message}/${index}`,
      name,
      mime: cleanLine(str(entry.mime_type) || "application/octet-stream"),
      bytes: num(entry.total_bytes) ?? 0,
      ...(path ? { path } : {}),
      missing: entry.missing === true || !path,
    }];
  });
}

function bodyOf(value: Json): string {
  const text = cleanText(str(value.text) ?? "");
  if (text) return text;
  const poll = isRecord(value.poll) ? str(value.poll.question) : undefined;
  return poll ? `Poll: ${cleanLine(poll)}` : "";
}

// One imsg message record becomes the message itself plus the tapbacks in its reaction
// snapshot. A standalone reaction event (watch with include_reactions) becomes one tapback.
// Tapback GUIDs use the reaction row id, so a snapshot and a live event for the same row merge.
export function parseMessageRecord(value: unknown): ParsedRecord {
  if (!isRecord(value)) throw new Error("message must be an object");
  const rawGuid = str(value.guid);
  if (!rawGuid) throw new Error("message is missing its guid");
  const chatGuid = parseChatGuid(str(value.chat_guid) ?? "");
  // Message rows carry no service; message.send_status reports it per GUID.
  const service = serviceOfChatGuid(chatGuid) ?? "iMessage";
  const rowId = num(value.id);
  const isFromMe = value.is_from_me === true;
  const sender = str(value.sender) ?? "";
  const senderName = str(value.sender_name);
  const from = handle(sender, isFromMe, service, senderName);
  const sentAt = time(value.created_at);
  const contacts: Contact[] = from.contact ? [from.contact] : [];

  if (value.is_reaction === true) {
    const kind = tapbackKind(value.reaction_type, value.reaction_emoji);
    const target = str(value.reacted_to_guid);
    if (!kind || !target || rowId === undefined) return { rowId, chatGuid, messages: [], contacts };
    const tapback: TapbackMessage = {
      kind: "tapback", guid: parseMessageGuid(`r:${rowId}`), chatGuid, sentAt, target: parseMessageGuid(stripPart(target)),
      ...kind, from, isFromMe, removed: value.is_reaction_add === false,
    };
    return { rowId, chatGuid, messages: [tapback], contacts };
  }

  const guid = parseMessageGuid(rawGuid);
  const reply = str(value.reply_to_guid) || str(value.thread_originator_guid);
  const text: TextMessage = {
    kind: "text", guid, chatGuid, sentAt, from, isFromMe,
    body: bodyOf(value), attachments: parseAttachments(value.attachments, rawGuid), status: "sent",
    ...(reply ? { replyTo: parseMessageGuid(stripPart(reply)) } : {}),
  };
  const messages: Message[] = [text];
  if (Array.isArray(value.reactions)) {
    for (const entry of value.reactions) {
      if (!isRecord(entry)) continue;
      const reactionId = num(entry.id);
      const kind = tapbackKind(entry.type, entry.emoji);
      if (reactionId === undefined || !kind) continue;
      const reactorIsMe = entry.is_from_me === true;
      const reactor = handle(str(entry.sender) ?? "", reactorIsMe, service, str(entry.sender_name));
      if (reactor.contact) contacts.push(reactor.contact);
      let reactedAt = sentAt;
      try { reactedAt = time(entry.created_at); } catch { /* keep the message time */ }
      messages.push({
        kind: "tapback", guid: parseMessageGuid(`r:${reactionId}`), chatGuid, sentAt: reactedAt, target: guid,
        ...kind, from: reactor, isFromMe: reactorIsMe, removed: false,
      });
    }
  }
  return { rowId, chatGuid, messages, contacts };
}
