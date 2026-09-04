import { parseHandleAddress, type ChatGuid, type HandleAddress, type MessageGuid } from "./ids.ts";
import type { AppEvent, AppState, Chat, Contact, Message, TextMessage } from "./model.ts";
import { previewBody } from "./model.ts";

function cloneMaps(state: AppState): AppState {
  return {
    ...state,
    chats: new Map(state.chats),
    messages: new Map(state.messages),
    contacts: new Map(state.contacts),
    typing: new Map(state.typing),
  };
}

function contactFor(contacts: Map<HandleAddress, Contact>, address: HandleAddress): Contact | undefined {
  const direct = contacts.get(address);
  if (direct) return direct;
  for (const contact of contacts.values()) {
    if (contact.phones.includes(address) || contact.emails.includes(address)) return contact;
  }
  return undefined;
}

function applyContactsToChat(chat: Chat, contacts: Map<HandleAddress, Contact>): Chat {
  const participants = chat.participants.map((handle) => {
    const contact = contactFor(contacts, handle.address);
    return contact ? { ...handle, contact } : handle;
  });
  let title = chat.title;
  if (chat.kind === "dm") {
    const other = participants[0];
    title = other?.contact?.displayName ?? other?.address ?? chat.title;
  } else if (!chat.title || chat.title === "Group") {
    title = participants.map((p) => p.contact?.displayName ?? p.address).join(", ");
  }
  return { ...chat, participants, title };
}

function upsertMessage(list: Message[], incoming: Message): Message[] {
  const byTemp =
    incoming.kind === "text" && incoming.tempGuid
      ? list.findIndex(
          (m) =>
            m.kind === "text" &&
            (m.guid === incoming.tempGuid || m.tempGuid === incoming.tempGuid),
        )
      : -1;
  const byGuid = list.findIndex((m) => m.guid === incoming.guid);
  const next = list.slice();
  if (byTemp >= 0) {
    next[byTemp] = incoming;
    return next;
  }
  if (byGuid >= 0) {
    next[byGuid] = incoming;
    return next;
  }
  next.push(incoming);
  next.sort((a, b) => a.sentAt - b.sentAt);
  return next;
}

function touchChat(chats: Map<ChatGuid, Chat>, message: Message, selected: ChatGuid | null): void {
  const existing = chats.get(message.chatGuid);
  if (!existing) return;
  const isFromMe = "isFromMe" in message ? message.isFromMe : false;
  const unread =
    message.chatGuid === selected || isFromMe
      ? existing.unreadCount
      : existing.unreadCount + (message.kind === "text" || message.kind === "attachment" ? 1 : 0);
  chats.set(message.chatGuid, {
    ...existing,
    lastMessage: {
      body: previewBody(message),
      sentAt: message.sentAt,
      isFromMe,
    },
    unreadCount: unread,
  });
}

function pendingText(args: {
  chatGuid: ChatGuid
  text: string
  tempGuid: MessageGuid
  now: number
}): TextMessage {
  return {
    kind: "text",
    guid: args.tempGuid,
    chatGuid: args.chatGuid,
    sentAt: args.now,
    from: { address: parseHandleAddress("me"), service: "iMessage" },
    isFromMe: true,
    body: args.text,
    tapbacks: [],
    status: "pending",
    tempGuid: args.tempGuid,
  };
}

export function reduce(state: AppState, event: AppEvent, now = Date.now()): AppState {
  switch (event.type) {
    case "connection":
      return { ...state, connection: event.connection };
    case "capabilities":
      return { ...state, capabilities: event.capabilities };
    case "chats-loaded": {
      const chats = new Map<ChatGuid, Chat>();
      for (const chat of event.chats) {
        chats.set(chat.guid, applyContactsToChat(chat, state.contacts));
      }
      return { ...state, chats };
    }
    case "contacts-loaded": {
      const next = cloneMaps(state);
      for (const contact of event.contacts) {
        for (const phone of contact.phones) next.contacts.set(phone, contact);
        for (const email of contact.emails) next.contacts.set(email, contact);
      }
      for (const [guid, chat] of next.chats) {
        next.chats.set(guid, applyContactsToChat(chat, next.contacts));
      }
      return next;
    }
    case "messages-loaded": {
      const next = cloneMaps(state);
      const sorted = event.messages.slice().sort((a, b) => a.sentAt - b.sentAt);
      next.messages.set(event.chatGuid, sorted);
      return next;
    }
    case "message-upserted": {
      const next = cloneMaps(state);
      const list = next.messages.get(event.message.chatGuid) ?? [];
      next.messages.set(event.message.chatGuid, upsertMessage(list, event.message));
      touchChat(next.chats, event.message, next.selected);
      return next;
    }
    case "typing": {
      const next = cloneMaps(state);
      next.typing.set(event.chatGuid, event.display);
      return next;
    }
    case "select-chat": {
      const chats = new Map(state.chats);
      const chat = chats.get(event.chatGuid);
      if (chat) chats.set(event.chatGuid, { ...chat, unreadCount: 0 });
      return {
        ...state,
        chats,
        selected: event.chatGuid,
        focus: "composer",
        overlay: "none",
      };
    }
    case "focus":
      return { ...state, focus: event.focus };
    case "composer-set":
      return { ...state, composer: event.text };
    case "search-set":
      return { ...state, search: event.text };
    case "overlay":
      return { ...state, overlay: event.overlay };
    case "send-requested": {
      const next = cloneMaps(state);
      const pending = pendingText({
        chatGuid: event.chatGuid,
        text: event.text,
        tempGuid: event.tempGuid,
        now,
      });
      const list = next.messages.get(event.chatGuid) ?? [];
      next.messages.set(event.chatGuid, upsertMessage(list, pending));
      touchChat(next.chats, pending, event.chatGuid);
      next.composer = "";
      return next;
    }
    case "send-acked": {
      const next = cloneMaps(state);
      for (const [guid, list] of next.messages) {
        next.messages.set(
          guid,
          list.map((message) => {
            if (message.kind !== "text") return message;
            if (message.guid !== event.tempGuid && message.tempGuid !== event.tempGuid) {
              return message;
            }
            return { ...message, guid: event.guid, status: "sent", tempGuid: event.tempGuid };
          }),
        );
      }
      return next;
    }
    case "send-failed": {
      const next = cloneMaps(state);
      for (const [guid, list] of next.messages) {
        next.messages.set(
          guid,
          list.map((message) => {
            if (message.kind !== "text") return message;
            if (message.guid !== event.tempGuid && message.tempGuid !== event.tempGuid) {
              return message;
            }
            return { ...message, status: "failed" };
          }),
        );
      }
      return next;
    }
    case "yank-done":
      return { ...state, copiedAt: now };
    case "mark-read": {
      const chats = new Map(state.chats);
      const chat = chats.get(event.chatGuid);
      if (chat) chats.set(event.chatGuid, { ...chat, unreadCount: 0 });
      return { ...state, chats };
    }
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}


