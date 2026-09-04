import type { ChatGuid, HandleAddress, MessageGuid } from "./ids.ts";

export type Service = "iMessage" | "SMS";
export type ChatKind = "dm" | "group";
export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";
export type Focus = "list" | "transcript" | "composer";
export type Overlay =
  | "none"
  | "search"
  | "new-message"
  | "details"
  | "help"
  | "tapback";
export type Connection = "offline" | "connecting" | "online" | "auth-failed";
export type Reaction =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question";

export type Contact = {
  displayName: string
  phones: HandleAddress[]
  emails: HandleAddress[]
};

export type Handle = {
  address: HandleAddress
  service: Service
  contact?: Contact
};

export type TapbackChip = {
  reaction: Reaction
  count: number
  fromMe: boolean
};

export type MessagePreview = {
  body: string
  sentAt: number
  isFromMe: boolean
};

export type Chat = {
  guid: ChatGuid
  kind: ChatKind
  service: Service
  title: string
  participants: Handle[]
  lastMessage?: MessagePreview
  unreadCount: number
  muted: boolean
};

type MessageBase = {
  guid: MessageGuid
  chatGuid: ChatGuid
  sentAt: number
};

export type TextMessage = MessageBase & {
  kind: "text"
  from: Handle
  isFromMe: boolean
  body: string
  deliveredAt?: number
  readAt?: number
  replyTo?: MessageGuid
  tapbacks: TapbackChip[]
  status: MessageStatus
  tempGuid?: MessageGuid
};

export type AttachmentMessage = MessageBase & {
  kind: "attachment"
  from: Handle
  isFromMe: boolean
  name: string
  mime: string
  bytes: number
  status: MessageStatus
};

export type TapbackMessage = MessageBase & {
  kind: "tapback"
  target: MessageGuid
  reaction: Reaction
  from: Handle
  isFromMe: boolean
  removed: boolean
};

export type GroupEventMessage = MessageBase & {
  kind: "group-event"
  action: "add" | "remove" | "leave" | "rename"
  actor: Handle
  detail: string
};

export type UnsentMessage = MessageBase & {
  kind: "unsent"
};

export type Message =
  | TextMessage
  | AttachmentMessage
  | TapbackMessage
  | GroupEventMessage
  | UnsentMessage;

export type Capabilities = {
  privateApi: boolean
  helperConnected: boolean
};

export type AppState = {
  connection: Connection
  capabilities: Capabilities
  chats: Map<ChatGuid, Chat>
  messages: Map<ChatGuid, Message[]>
  contacts: Map<HandleAddress, Contact>
  selected: ChatGuid | null
  focus: Focus
  composer: string
  search: string
  overlay: Overlay
  typing: Map<ChatGuid, boolean>
  copiedAt: number | null
};

export type AppEvent =
  | { type: "connection"; connection: Connection }
  | { type: "capabilities"; capabilities: Capabilities }
  | { type: "chats-loaded"; chats: Chat[] }
  | { type: "contacts-loaded"; contacts: Contact[] }
  | { type: "messages-loaded"; chatGuid: ChatGuid; messages: Message[] }
  | { type: "message-upserted"; message: Message }
  | { type: "typing"; chatGuid: ChatGuid; display: boolean }
  | { type: "select-chat"; chatGuid: ChatGuid }
  | { type: "focus"; focus: Focus }
  | { type: "composer-set"; text: string }
  | { type: "search-set"; text: string }
  | { type: "overlay"; overlay: Overlay }
  | {
      type: "send-requested"
      chatGuid: ChatGuid
      text: string
      tempGuid: MessageGuid
    }
  | { type: "send-acked"; tempGuid: MessageGuid; guid: MessageGuid }
  | { type: "send-failed"; tempGuid: MessageGuid }
  | { type: "yank-done" }
  | { type: "mark-read"; chatGuid: ChatGuid };

export function emptyState(): AppState {
  return {
    connection: "connecting",
    capabilities: { privateApi: false, helperConnected: false },
    chats: new Map(),
    messages: new Map(),
    contacts: new Map(),
    selected: null,
    focus: "list",
    composer: "",
    search: "",
    overlay: "none",
    typing: new Map(),
    copiedAt: null,
  };
}

export function previewBody(message: Message): string {
  switch (message.kind) {
    case "text":
      return message.body;
    case "attachment":
      return `[${message.name}]`;
    case "tapback":
      return message.reaction;
    case "group-event":
      return message.detail;
    case "unsent":
      return "Unsent";
    default: {
      const _exhaustive: never = message;
      return _exhaustive;
    }
  }
}
