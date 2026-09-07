import type { ChatGuid, HandleAddress, MessageGuid } from "./ids.ts";

export type Service = "iMessage" | "SMS";
export type ChatKind = "dm" | "group";
export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed" | "uncertain";
export type Connection = "offline" | "connecting" | "online" | "auth-failed";
export type Reaction = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
export type Contact = { displayName: string; phones: HandleAddress[]; emails: HandleAddress[] };
export type Handle = { address: HandleAddress; service: Service; contact?: Contact };
export type TapbackChip = { reaction: Reaction; count: number; fromMe: boolean };
export type Attachment = { guid: string; name: string; mime: string; bytes: number };
export type MessagePreview = { body: string; sentAt: number; isFromMe: boolean; guid?: MessageGuid };
export type Chat = {
  guid: ChatGuid; kind: ChatKind; service: Service; title: string; participants: Handle[];
  lastMessage?: MessagePreview; unreadCount: number; muted: boolean; provisional?: boolean;
};
type MessageBase = { guid: MessageGuid; chatGuid: ChatGuid; sentAt: number };
export type TextMessage = MessageBase & {
  kind: "text"; from: Handle; isFromMe: boolean; body: string; attachments: Attachment[];
  deliveredAt?: number; readAt?: number; editedAt?: number; replyTo?: MessageGuid;
  status: MessageStatus; tempGuid?: MessageGuid;
};
export type TapbackMessage = MessageBase & {
  kind: "tapback"; target: MessageGuid; reaction: Reaction; from: Handle; isFromMe: boolean; removed: boolean;
};
export type GroupEventMessage = MessageBase & {
  kind: "group-event"; action: "add" | "remove" | "leave" | "rename"; actor: Handle; detail: string;
};
export type UnsentMessage = MessageBase & { kind: "unsent" };
export type Message = TextMessage | TapbackMessage | GroupEventMessage | UnsentMessage;
export type Capabilities = { privateApi: boolean; helperConnected: boolean };
export type Draft = { text: string; replyTo: MessageGuid | null };
export type HistoryCursor = { before: number; offset: number };
export type MessagePage = { messages: Message[]; next: HistoryCursor | null; total: number };
export type ChatPage = { chats: Chat[]; nextOffset: number | null };
export type PageMode = "latest" | "older";
export type HistoryState =
  | { kind: "unloaded" }
  | { kind: "loading"; request: number; mode: PageMode; hasPage: boolean; next: HistoryCursor | null }
  | { kind: "ready"; next: HistoryCursor | null }
  | { kind: "error"; message: string; mode: PageMode; hasPage: boolean; next: HistoryCursor | null };
export type Pane = { kind: "list" } | { kind: "transcript"; chatGuid: ChatGuid } | { kind: "composer"; chatGuid: ChatGuid };
export type InputMode = Pane
  | { kind: "help"; returnTo: Pane }
  | { kind: "search"; returnTo: Pane }
  | { kind: "new-chat"; addresses: string; text: string; service: Service; field: "addresses" | "text"; busy: boolean; error: string | null }
  | { kind: "tapback"; chatGuid: ChatGuid; messageGuid: MessageGuid; choice: number }
  | { kind: "attachments"; chatGuid: ChatGuid; messageGuid: MessageGuid; choice: number }
  | { kind: "image"; attachment: Attachment; returnTo: Pane }
  | { kind: "retry-confirm"; tempGuid: MessageGuid; returnTo: Pane };
export type Notice = { kind: "info" | "error"; text: string };
export type Outgoing = {
  tempGuid: MessageGuid; chatGuid: ChatGuid; text: string; replyTo: MessageGuid | null;
  createdAt: number; phase: "sending" | "failed" | "uncertain"; error: string | null;
};
export type SavedSession = { drafts: [ChatGuid, Draft][]; outbox: Outgoing[]; readAt: [ChatGuid, number][] };
export type AppState = {
  connection: Connection; capabilities: Capabilities;
  chats: Map<ChatGuid, Chat>; messages: Map<ChatGuid, Message[]>; contacts: Map<HandleAddress, Contact>;
  history: Map<ChatGuid, HistoryState>; drafts: Map<ChatGuid, Draft>; outbox: Map<MessageGuid, Outgoing>;
  readAt: Map<ChatGuid, number>; readPending: Map<ChatGuid, string | null>;
  selected: ChatGuid | null; listCursor: ChatGuid | null; messageCursor: Map<ChatGuid, MessageGuid>;
  input: InputMode; search: string; typing: Map<ChatGuid, boolean>; notice: Notice | null;
  chatsStatus: "loading" | "ready" | "error";
};
export type Intent =
  | { type: "input"; input: InputMode }
  | { type: "move-list"; delta: number }
  | { type: "open-chat"; chatGuid: ChatGuid }
  | { type: "move-message"; chatGuid: ChatGuid; delta: number }
  | { type: "select-message"; chatGuid: ChatGuid; messageGuid: MessageGuid }
  | { type: "draft-set"; chatGuid: ChatGuid; text: string }
  | { type: "reply"; chatGuid: ChatGuid; messageGuid: MessageGuid | null }
  | { type: "search-set"; text: string }
  | { type: "send"; chatGuid: ChatGuid }
  | { type: "retry-send"; tempGuid: MessageGuid; confirmed?: boolean }
  | { type: "load-history"; chatGuid: ChatGuid; mode: PageMode }
  | { type: "refresh" }
  | { type: "retry-read"; chatGuid: ChatGuid }
  | { type: "react"; chatGuid: ChatGuid; messageGuid: MessageGuid; reaction: Reaction; remove: boolean }
  | { type: "create-chat"; addresses: string; text: string; service: Service }
  | { type: "attachment"; attachment: Attachment; action: "open" | "save" }
  | { type: "copy"; text: string }
  | { type: "notice"; notice: Notice | null }
  | { type: "quit" };
export type AppEvent = Intent
  | { type: "connection"; connection: Connection }
  | { type: "capabilities"; capabilities: Capabilities }
  | { type: "chats-loaded"; chats: Chat[] }
  | { type: "chats-status"; status: AppState["chatsStatus"] }
  | { type: "contacts-loaded"; contacts: Contact[] }
  | { type: "history-loading"; chatGuid: ChatGuid; request: number; mode: PageMode }
  | { type: "history-loaded"; chatGuid: ChatGuid; request: number; page: MessagePage }
  | { type: "history-failed"; chatGuid: ChatGuid; request: number; message: string }
  | { type: "messages-loaded"; chatGuid: ChatGuid; messages: Message[] }
  | { type: "message-upserted"; message: Message }
  | { type: "typing"; chatGuid: ChatGuid; display: boolean }
  | { type: "send-requested"; chatGuid: ChatGuid; text: string; tempGuid: MessageGuid; replyTo?: MessageGuid }
  | { type: "send-acked"; tempGuid: MessageGuid; guid: MessageGuid }
  | { type: "send-failed"; tempGuid: MessageGuid; error: string; uncertain: boolean }
  | { type: "read-requested"; chatGuid: ChatGuid }
  | { type: "read-succeeded"; chatGuid: ChatGuid }
  | { type: "read-failed"; chatGuid: ChatGuid; message: string }
  | { type: "mark-read"; chatGuid: ChatGuid }
  | { type: "restore"; saved: SavedSession };
export type Session = {
  getSnapshot: () => AppState;
  subscribe: (listener: () => void) => () => void;
  act: (intent: Intent) => void;
  loadAttachment: (attachment: Attachment) => Promise<Uint8Array>;
  start: () => Promise<void>;
  close: () => Promise<void>;
};
export function emptyState(): AppState {
  return {
    connection: "connecting", capabilities: { privateApi: false, helperConnected: false },
    chats: new Map(), messages: new Map(), contacts: new Map(), history: new Map(), drafts: new Map(),
    outbox: new Map(), readAt: new Map(), readPending: new Map(), selected: null, listCursor: null,
    messageCursor: new Map(), input: { kind: "list" }, search: "", typing: new Map(), notice: null,
    chatsStatus: "loading",
  };
}
export function previewBody(message: Message): string {
  switch (message.kind) {
    case "text": return message.body || message.attachments.map(a => `[${a.name}]`).join(" ");
    case "tapback": return message.reaction;
    case "group-event": return message.detail;
    case "unsent": return "Unsent a message";
  }
}
export function draftFor(state: AppState, chatGuid: ChatGuid): Draft {
  return state.drafts.get(chatGuid) ?? { text: "", replyTo: null };
}
export function privateApiAvailable(capabilities: Capabilities): boolean {
  return capabilities.privateApi && capabilities.helperConnected;
}
