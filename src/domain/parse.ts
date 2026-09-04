import {
  parseChatGuid,
  parseHandleAddress,
  parseMessageGuid,
  type ChatGuid,
  type HandleAddress,
} from "./ids.ts";
import type {
  AttachmentMessage,
  Chat,
  ChatKind,
  Contact,
  GroupEventMessage,
  Handle,
  Message,
  Reaction,
  Service,
  TapbackMessage,
  TextMessage,
} from "./model.ts";

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REACTION_BY_TYPE: Record<number, { reaction: Reaction; removed: boolean }> = {
  2000: { reaction: "love", removed: false },
  2001: { reaction: "like", removed: false },
  2002: { reaction: "dislike", removed: false },
  2003: { reaction: "laugh", removed: false },
  2004: { reaction: "emphasize", removed: false },
  2005: { reaction: "question", removed: false },
  3000: { reaction: "love", removed: true },
  3001: { reaction: "like", removed: true },
  3002: { reaction: "dislike", removed: true },
  3003: { reaction: "laugh", removed: true },
  3004: { reaction: "emphasize", removed: true },
  3005: { reaction: "question", removed: true },
};

const NAMED_REACTION: Record<string, Reaction> = {
  love: "love",
  like: "like",
  dislike: "dislike",
  laugh: "laugh",
  emphasize: "emphasize",
  question: "question",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseService(value: unknown): Service {
  const raw = str(value)?.toLowerCase();
  if (raw === "sms" || raw === "rcs") return "SMS";
  return "iMessage";
}

export function parseHandle(value: unknown, fallbackService: Service): Handle {
  if (typeof value === "string") {
    return { address: parseHandleAddress(value), service: fallbackService };
  }
  if (!isRecord(value)) {
    return { address: parseHandleAddress("unknown"), service: fallbackService };
  }
  const address = str(value.address) ?? str(value.id) ?? "unknown";
  return {
    address: parseHandleAddress(address),
    service: parseService(value.service ?? fallbackService),
  };
}

function parseKind(value: unknown, guid: string, participantCount: number): ChatKind {
  const style = num(value);
  if (style === 43) return "group";
  if (style === 45) return "dm";
  if (guid.includes(";+;chat") || guid.includes(";-;chat")) return "group";
  return participantCount > 1 ? "group" : "dm";
}

function chatService(guid: string): Service {
  return guid.startsWith("SMS;") ? "SMS" : "iMessage";
}

export function parseContact(value: unknown): Contact | undefined {
  if (!isRecord(value)) return undefined;
  const displayName =
    str(value.displayName) ??
    [str(value.firstName), str(value.lastName)].filter(Boolean).join(" ").trim();
  if (!displayName) return undefined;
  const phones: HandleAddress[] = [];
  const emails: HandleAddress[] = [];
  const phoneSrc = value.phoneNumbers;
  const emailSrc = value.emails;
  if (Array.isArray(phoneSrc)) {
    for (const entry of phoneSrc) {
      const address = isRecord(entry) ? str(entry.address) : str(entry);
      if (address) phones.push(parseHandleAddress(address));
    }
  }
  if (Array.isArray(emailSrc)) {
    for (const entry of emailSrc) {
      const address = isRecord(entry) ? str(entry.address) : str(entry);
      if (address) emails.push(parseHandleAddress(address));
    }
  }
  const extra = value.addresses;
  if (Array.isArray(extra)) {
    for (const entry of extra) {
      const address = isRecord(entry) ? str(entry.address) : str(entry);
      if (!address) continue;
      if (address.includes("@")) emails.push(parseHandleAddress(address));
      else phones.push(parseHandleAddress(address));
    }
  }
  return { displayName, phones, emails };
}

function titleFromChat(record: Record<string, unknown>, kind: ChatKind, participants: Handle[]): string {
  const named = str(record.displayName);
  if (named && named.length > 0) return named;
  if (kind === "group") {
    const names = participants.map((p) => p.contact?.displayName ?? p.address);
    return names.length > 0 ? names.join(", ") : "Group";
  }
  const other = participants[0];
  return other?.contact?.displayName ?? other?.address ?? "Unknown";
}

export function parseChat(value: unknown): Chat {
  if (!isRecord(value)) throw new Error("expected chat object");
  const guidRaw = str(value.guid);
  if (!guidRaw) throw new Error("chat missing guid");
  const guid = parseChatGuid(guidRaw);
  const service = chatService(guidRaw);
  const participantsRaw = Array.isArray(value.participants) ? value.participants : [];
  const participants = participantsRaw.map((p) => parseHandle(p, service));
  const kind = parseKind(value.style, guidRaw, participants.length);
  const last = isRecord(value.lastMessage) ? value.lastMessage : undefined;
  const chat: Chat = {
    guid,
    kind,
    service,
    title: titleFromChat(value, kind, participants),
    participants,
    unreadCount: num(value.unreadCount) ?? 0,
    muted: bool(value.isMuted) ?? false,
  };
  if (last) {
    chat.lastMessage = {
      body: str(last.text) ?? str(last.universalText) ?? "",
      sentAt: num(last.dateCreated) ?? 0,
      isFromMe: bool(last.isFromMe) ?? false,
    };
  }
  return chat;
}

function parseReactionNamed(value: unknown): Reaction | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const key = raw.startsWith("-") ? raw.slice(1) : raw;
  return NAMED_REACTION[key];
}

function groupAction(itemType: number | undefined, groupActionType: number | undefined): GroupEventMessage["action"] | undefined {
  if (itemType === 1 && groupActionType === 0) return "add";
  if (itemType === 1 && groupActionType === 1) return "remove";
  if (itemType === 3) return "leave";
  if (itemType === 2) return "rename";
  return undefined;
}

function chatGuidFromMessage(record: Record<string, unknown>): ChatGuid {
  const chats = record.chats;
  if (Array.isArray(chats) && isRecord(chats[0]) && str(chats[0].guid)) {
    return parseChatGuid(chats[0].guid as string);
  }
  const nested = str(record.chatGuid) ?? str(record.chat_guid);
  if (nested) return parseChatGuid(nested);
  throw new Error("message missing chat guid");
}

export function parseMessage(value: unknown): Message | undefined {
  if (!isRecord(value)) return undefined;
  const guidRaw = str(value.guid);
  if (!guidRaw) return undefined;
  const text = str(value.text) ?? str(value.universalText) ?? "";
  if (UUID_ONLY.test(text)) return undefined;

  const guid = parseMessageGuid(guidRaw);
  const chatGuid = chatGuidFromMessage(value);
  const sentAt = num(value.dateCreated) ?? 0;
  const isFromMe = bool(value.isFromMe) ?? false;
  const service = parseService(isRecord(value.handle) ? value.handle.service : undefined);
  const from = parseHandle(value.handle, service);
  const itemType = num(value.itemType);
  const action = groupAction(itemType, num(value.groupActionType));
  if (action) {
    return {
      kind: "group-event",
      guid,
      chatGuid,
      sentAt,
      action,
      actor: from,
      detail: text || action,
    };
  }

  const assocType = num(value.associatedMessageType);
  const assocGuid = str(value.associatedMessageGuid);
  if (assocType !== undefined && assocGuid && REACTION_BY_TYPE[assocType]) {
    const mapped = REACTION_BY_TYPE[assocType];
    return {
      kind: "tapback",
      guid,
      chatGuid,
      sentAt,
      target: parseMessageGuid(assocGuid.replace(/^p:\d+\//, "")),
      reaction: mapped.reaction,
      from,
      isFromMe,
      removed: mapped.removed,
    } satisfies TapbackMessage;
  }

  const named = parseReactionNamed(value.reaction);
  if (named && assocGuid) {
    return {
      kind: "tapback",
      guid,
      chatGuid,
      sentAt,
      target: parseMessageGuid(assocGuid),
      reaction: named,
      from,
      isFromMe,
      removed: str(value.reaction)?.startsWith("-") ?? false,
    };
  }

  if (bool(value.dateRetracted) || num(value.dateRetracted)) {
    return { kind: "unsent", guid, chatGuid, sentAt };
  }

  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  if (attachments.length > 0 && text.length === 0) {
    const first = isRecord(attachments[0]) ? attachments[0] : {};
    return {
      kind: "attachment",
      guid,
      chatGuid,
      sentAt,
      from,
      isFromMe,
      name: str(first.transferName) ?? str(first.uti) ?? "file",
      mime: str(first.mimeType) ?? "application/octet-stream",
      bytes: num(first.totalBytes) ?? 0,
      status: isFromMe ? "sent" : "delivered",
    } satisfies AttachmentMessage;
  }

  const error = num(value.error) ?? 0;
  const deliveredAt = num(value.dateDelivered);
  const readAt = num(value.dateRead);
  let status: TextMessage["status"] = "sent";
  if (error !== 0) status = "failed";
  else if (readAt) status = "read";
  else if (deliveredAt) status = "delivered";
  else if (isFromMe) status = "sent";

  const temp = str(value.tempGuid);
  const reply = str(value.threadOriginatorGuid);
  const textMessage: TextMessage = {
    kind: "text",
    guid,
    chatGuid,
    sentAt,
    from,
    isFromMe,
    body: text,
    tapbacks: [],
    status,
  };
  if (deliveredAt !== undefined) textMessage.deliveredAt = deliveredAt;
  if (readAt !== undefined) textMessage.readAt = readAt;
  if (reply) textMessage.replyTo = parseMessageGuid(reply);
  if (temp) textMessage.tempGuid = parseMessageGuid(temp);
  return textMessage;
}

export function parseEnvelopeData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("data" in value) return value.data;
  return value;
}

export function parseChatList(value: unknown): Chat[] {
  const data = parseEnvelopeData(value);
  if (!Array.isArray(data)) return [];
  const chats: Chat[] = [];
  for (const item of data) {
    try {
      chats.push(parseChat(item));
    } catch {
      continue;
    }
  }
  return chats;
}

export function parseMessageList(value: unknown): Message[] {
  const data = parseEnvelopeData(value);
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const parsed = parseMessage(item);
    return parsed ? [parsed] : [];
  });
}

export function parseContactList(value: unknown): Contact[] {
  const data = parseEnvelopeData(value);
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const parsed = parseContact(item);
    return parsed ? [parsed] : [];
  });
}

export function parseServerInfo(value: unknown): { privateApi: boolean; helperConnected: boolean } {
  const data = isRecord(value) && isRecord(value.data) ? value.data : isRecord(value) ? value : {};
  return {
    privateApi: bool(data.private_api) ?? false,
    helperConnected: bool(data.helper_connected) ?? false,
  };
}
