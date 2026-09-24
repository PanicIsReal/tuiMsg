import { contactLookupKey, parseHandleAddress, type ChatGuid, type HandleAddress } from "./ids.ts";
import type { AppEvent, AppState, Chat, Contact, Handle, HistoryState, Message, MessageStatus, Outgoing, Service, TextMessage } from "./model.ts";
import { chatActivity, previewBody, serviceOfChatGuid } from "./model.ts";

function cloneState(state: AppState): AppState {
  return { ...state, chats: new Map(state.chats), messages: new Map(state.messages), contacts: new Map(state.contacts), history: new Map(state.history), drafts: new Map(state.drafts), outbox: new Map(state.outbox), readAt: new Map(state.readAt), readPending: new Map(state.readPending), messageCursor: new Map(state.messageCursor), typing: new Map(state.typing) };
}

function applyContact(handle: Handle, contacts: Map<HandleAddress, Contact>): Handle {
  const key = contactLookupKey(handle.address);
  let contact = contacts.get(key);
  if (!contact) {
    const local = key.match(/^\+?1?([2-9]\d{2}[2-9]\d{6})$/)?.[1];
    if (local) {
      const candidates = new Set([local, `1${local}`, `+${local}`, `+1${local}`]
        .map((address) => contacts.get(parseHandleAddress(address)))
        .filter((candidate) => candidate !== undefined));
      if (candidates.size > 1) return { address: handle.address, service: handle.service };
      contact = candidates.values().next().value;
    }
  }
  return contact ? { ...handle, contact } : handle;
}

function applyContactsToChat(chat: Chat, contacts: Map<HandleAddress, Contact>): Chat {
  const participants = chat.participants.map((handle) => applyContact(handle, contacts));
  let title = chat.title;
  if (chat.kind === "dm") {
    const other = participants[0];
    title = other?.contact?.displayName ?? other?.address ?? title;
  } else if (!title || title === "Group" || title === chat.participants.map((handle) => handle.address).join(", ") ||
      // Names arrive a sender at a time, so a partly named title is still a derived one.
      title === chat.participants.map((handle) => handle.contact?.displayName ?? handle.address).join(", ")) {
    title = participants.map((handle) => handle.contact?.displayName ?? handle.address).join(", ");
  }
  return { ...chat, participants, title };
}

function applyContactsToMessage(message: Message, contacts: Map<HandleAddress, Contact>): Message {
  switch (message.kind) {
    case "text":
    case "tapback": return { ...message, from: applyContact(message.from, contacts) };
    case "group-event": return { ...message, actor: applyContact(message.actor, contacts) };
    case "unsent": return message;
  }
}

const statusRank: Record<MessageStatus, number> = { pending: 0, failed: 0, uncertain: 0, sent: 1, delivered: 2, read: 3 };

function mergeText(existing: TextMessage, incoming: TextMessage): TextMessage {
  const keepReceipt = statusRank[existing.status] > statusRank[incoming.status];
  const merged: TextMessage = {
    ...existing,
    ...incoming,
    guid: incoming.guid === existing.tempGuid ? existing.guid : incoming.guid,
    status: keepReceipt ? existing.status : incoming.status,
  };
  if ((existing.editedAt ?? 0) > (incoming.editedAt ?? 0)) {
    merged.body = existing.body;
    merged.attachments = existing.attachments;
    if (existing.editedAt !== undefined) merged.editedAt = existing.editedAt;
  }
  const tempGuid = incoming.tempGuid ?? existing.tempGuid;
  const deliveredAt = Math.max(existing.deliveredAt ?? 0, incoming.deliveredAt ?? 0);
  const readAt = Math.max(existing.readAt ?? 0, incoming.readAt ?? 0);
  if (tempGuid) merged.tempGuid = tempGuid; else delete merged.tempGuid;
  if (deliveredAt) merged.deliveredAt = deliveredAt; else delete merged.deliveredAt;
  if (readAt) merged.readAt = readAt; else delete merged.readAt;
  return merged;
}

function sameIdentity(existing: Message, incoming: Message): boolean {
  if (existing.guid === incoming.guid) return true;
  if (existing.kind !== "text" || incoming.kind !== "text") return false;
  return existing.guid === incoming.tempGuid || incoming.guid === existing.tempGuid || (existing.tempGuid !== undefined && existing.tempGuid === incoming.tempGuid);
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const merged = current.slice();
  for (const message of incoming) {
    const index = merged.findIndex((candidate) => sameIdentity(candidate, message));
    if (index < 0) merged.push(message);
    else {
      const existing = merged[index];
      if (existing?.kind === "unsent" && message.kind !== "unsent") merged[index] = existing;
      else merged[index] = existing?.kind === "text" && message.kind === "text" ? mergeText(existing, message) : message;
    }
  }
  return merged.sort((a, b) => a.sentAt - b.sentAt || a.guid.localeCompare(b.guid));
}

function provisionalChat(message: Message): Chat {
  const handle = "from" in message ? message.from : message.kind === "group-event" ? message.actor : { address: parseHandleAddress("unknown"), service: "iMessage" as const };
  const title = "isFromMe" in message && message.isFromMe
    ? message.chatGuid.split(";").slice(2).join(";")
    : handle.contact?.displayName ?? handle.address;
  return { guid: message.chatGuid, kind: "dm", service: handle.service, title, participants: [handle], unreadCount: 0, muted: false, provisional: true };
}

function readingChat(state: AppState): ChatGuid | null {
  return state.input.kind === "transcript" || state.input.kind === "composer" ? state.input.chatGuid : null;
}

function touchChat(chats: Map<ChatGuid, Chat>, message: Message, selected: ChatGuid | null, isNew: boolean, readAt = 0): void {
  const existing = chats.get(message.chatGuid) ?? provisionalChat(message);
  const fromMe = "isFromMe" in message && message.isFromMe;
  const usePreview = message.kind !== "tapback" && (!existing.lastMessage || message.sentAt >= existing.lastMessage.sentAt);
  const updated: Chat = {
    ...existing,
    unreadCount: isNew && message.sentAt > readAt && message.kind === "text" && !fromMe && message.chatGuid !== selected ? existing.unreadCount + 1 : existing.unreadCount,
  };
  if (usePreview) updated.lastMessage = { body: previewBody(message), sentAt: message.sentAt, isFromMe: fromMe, guid: message.guid };
  chats.set(message.chatGuid, updated);
}

function pendingText(outgoing: Outgoing, now: number, service: Service = serviceOfChatGuid(outgoing.chatGuid) ?? "iMessage"): TextMessage {
  const message: TextMessage = { kind: "text", guid: outgoing.tempGuid, chatGuid: outgoing.chatGuid, sentAt: outgoing.createdAt || now, from: { address: parseHandleAddress("me"), service }, isFromMe: true, body: outgoing.text, attachments: [], status: outgoing.phase === "sending" ? "pending" : outgoing.phase, tempGuid: outgoing.tempGuid };
  if (outgoing.replyTo) message.replyTo = outgoing.replyTo;
  return message;
}

function visibleChats(state: AppState): ChatGuid[] {
  const query = state.search.trim().toLowerCase();
  return [...state.chats.values()].filter((chat) => !query || chat.title.toLowerCase().includes(query) || (chat.lastMessage?.body.toLowerCase().includes(query) ?? false)).sort((a, b) => chatActivity(b) - chatActivity(a)).map((chat) => chat.guid);
}

function moved<T>(items: T[], current: T | null | undefined, delta: number): T | null {
  if (items.length === 0) return null;
  const found = current == null ? -1 : items.indexOf(current);
  const start = found < 0 ? (delta < 0 ? 0 : -1) : found;
  return items[Math.max(0, Math.min(items.length - 1, start + delta))] ?? null;
}

function completedHistory(current: HistoryState | undefined, event: Extract<AppEvent, { type: "history-loaded" }>): HistoryState | undefined {
  if (current?.kind !== "loading" || current.request !== event.request) return undefined;
  return { kind: "ready", next: current.mode === "latest" && current.hasPage ? current.next : event.page.next };
}

export function reduce(state: AppState, event: AppEvent, now = Date.now()): AppState {
  switch (event.type) {
    case "input": return { ...state, input: event.input };
    case "move-list": return { ...state, listCursor: moved(visibleChats(state), state.listCursor, event.delta) };
    case "open-chat": {
      const chats = new Map(state.chats);
      const chat = chats.get(event.chatGuid);
      if (chat) chats.set(event.chatGuid, { ...chat, unreadCount: 0 });
      return { ...state, chats, selected: event.chatGuid, input: { kind: "transcript", chatGuid: event.chatGuid } };
    }
    case "move-message": {
      const guids = (state.messages.get(event.chatGuid) ?? []).filter((message) => message.kind !== "tapback").map((message) => message.guid);
      const messageCursor = new Map(state.messageCursor);
      const cursor = moved(guids, messageCursor.get(event.chatGuid) ?? guids.at(-1), event.delta);
      if (cursor) messageCursor.set(event.chatGuid, cursor); else messageCursor.delete(event.chatGuid);
      return { ...state, messageCursor };
    }
    case "select-message": {
      const messageCursor = new Map(state.messageCursor);
      messageCursor.set(event.chatGuid, event.messageGuid);
      return { ...state, messageCursor };
    }
    case "draft-set": {
      const drafts = new Map(state.drafts);
      drafts.set(event.chatGuid, { ...(drafts.get(event.chatGuid) ?? { text: "", replyTo: null }), text: event.text });
      return { ...state, drafts };
    }
    case "reply": {
      const drafts = new Map(state.drafts);
      drafts.set(event.chatGuid, { ...(drafts.get(event.chatGuid) ?? { text: "", replyTo: null }), replyTo: event.messageGuid });
      return { ...state, drafts, input: { kind: "composer", chatGuid: event.chatGuid } };
    }
    case "search-set": {
      const next = { ...state, search: event.text };
      const visible = visibleChats(next);
      return { ...next, listCursor: state.listCursor && visible.includes(state.listCursor) ? state.listCursor : visible[0] ?? null };
    }
    case "send": case "load-history": case "react": case "create-chat": case "attachment": case "copy": case "open-link": case "quit": return state;
    case "retry-send": {
      const outgoing = state.outbox.get(event.tempGuid);
      if (!outgoing) return state;
      if (outgoing.phase === "uncertain" && !event.confirmed) {
        const returnTo = state.input.kind === "list" || state.input.kind === "transcript" || state.input.kind === "composer" ? state.input : { kind: "list" as const };
        return { ...state, input: { kind: "retry-confirm", tempGuid: event.tempGuid, returnTo } };
      }
      const next = cloneState(state);
      next.outbox.set(event.tempGuid, { ...outgoing, phase: "sending", error: null });
      next.messages.set(outgoing.chatGuid, (next.messages.get(outgoing.chatGuid) ?? []).map((message) => message.kind === "text" && sameIdentity(message, pendingText(outgoing, now)) ? { ...message, status: "pending" } : message));
      return next;
    }
    case "refresh": return { ...state, chatsStatus: "loading" };
    case "retry-read": case "read-requested": {
      const readPending = new Map(state.readPending);
      readPending.set(event.chatGuid, null);
      return { ...state, readPending };
    }
    case "notice": return { ...state, notice: event.notice };
    case "connection": return { ...state, connection: event.connection, unavailable: event.connection === "no-access" ? event.reason ?? null : null };
    case "capabilities": return { ...state, capabilities: event.capabilities };
    case "chats-loaded": {
      const chats = new Map(state.chats);
      for (const incoming of event.chats) {
        const existing = chats.get(incoming.guid);
        const lastMessage = existing?.lastMessage && (!incoming.lastMessage || existing.lastMessage.sentAt > incoming.lastMessage.sentAt) ? existing.lastMessage : incoming.lastMessage;
        // The Messages database owns unread state; a chat read here without the bridge stays read locally.
        const alreadyRead = incoming.guid === readingChat(state) || chatActivity(incoming) <= (state.readAt.get(incoming.guid) ?? 0);
        const merged: Chat = { ...existing, ...incoming, unreadCount: alreadyRead ? 0 : incoming.unreadCount };
        delete merged.provisional;
        // A refreshed row brings back its stored service; what a message showed stays.
        if (existing?.serviceAt !== undefined && incoming.serviceAt === undefined && serviceOfChatGuid(incoming.guid) === undefined) {
          merged.service = existing.service;
          merged.serviceAt = existing.serviceAt;
        }
        if (lastMessage) merged.lastMessage = lastMessage; else delete merged.lastMessage;
        chats.set(incoming.guid, applyContactsToChat(merged, state.contacts));
      }
      const next = { ...state, chats };
      const visible = visibleChats(next);
      return { ...next, listCursor: state.listCursor && chats.has(state.listCursor) ? state.listCursor : visible[0] ?? null };
    }
    case "chats-status": return { ...state, chatsStatus: event.status };
    case "chat-previews": {
      // One copy of the chat map for the whole batch.
      let chats: Map<ChatGuid, Chat> | undefined;
      for (const { chatGuid, message } of event.previews) {
        const chat = (chats ?? state.chats).get(chatGuid);
        if (!chat || (chat.lastMessage && chat.lastMessage.sentAt > message.sentAt)) continue;
        chats ??= new Map(state.chats);
        const fromMe = "isFromMe" in message && message.isFromMe;
        chats.set(chatGuid, { ...chat, lastMessage: { body: previewBody(message), sentAt: message.sentAt, isFromMe: fromMe, guid: message.guid } });
      }
      return chats ? { ...state, chats } : state;
    }
    case "chat-service": {
      const chat = state.chats.get(event.chatGuid);
      // Evidence from an older message never overrides a newer one.
      if (!chat || event.at < (chat.serviceAt ?? Number.NEGATIVE_INFINITY) || (chat.service === event.service && chat.serviceAt === event.at)) return state;
      const chats = new Map(state.chats);
      chats.set(event.chatGuid, { ...chat, service: event.service, serviceAt: event.at });
      return { ...state, chats };
    }
    case "contacts-loaded": {
      const next = cloneState(state);
      for (const contact of event.contacts) for (const address of [...contact.phones, ...contact.emails]) next.contacts.set(contactLookupKey(address), contact);
      for (const [guid, chat] of next.chats) next.chats.set(guid, applyContactsToChat(chat, next.contacts));
      for (const [guid, messages] of next.messages) next.messages.set(guid, messages.map((message) => applyContactsToMessage(message, next.contacts)));
      return next;
    }
    case "history-loading": {
      const history = new Map(state.history);
      const current = history.get(event.chatGuid);
      history.set(event.chatGuid, { kind: "loading", request: event.request, mode: event.mode, hasPage: current?.kind === "ready" || ((current?.kind === "error" || current?.kind === "loading") && current.hasPage), next: current && "next" in current ? current.next : null });
      return { ...state, history };
    }
    case "history-loaded": {
      const result = completedHistory(state.history.get(event.chatGuid), event);
      if (!result) return state;
      const next = cloneState(state);
      next.history.set(event.chatGuid, result);
      next.messages.set(event.chatGuid, mergeMessages(next.messages.get(event.chatGuid) ?? [], event.page.messages.map((message) => applyContactsToMessage(message, next.contacts))));
      return next;
    }
    case "history-failed": {
      const current = state.history.get(event.chatGuid);
      if (current?.kind !== "loading" || current.request !== event.request) return state;
      const history = new Map(state.history);
      history.set(event.chatGuid, { kind: "error", message: event.message, mode: current.mode, hasPage: current.hasPage, next: current.next });
      return { ...state, history };
    }
    case "messages-loaded": {
      const next = cloneState(state);
      next.messages.set(event.chatGuid, mergeMessages(next.messages.get(event.chatGuid) ?? [], event.messages.map((message) => applyContactsToMessage(message, next.contacts))));
      return next;
    }
    case "message-upserted": {
      const next = cloneState(state);
      const message = applyContactsToMessage(event.message, next.contacts);
      const current = next.messages.get(message.chatGuid) ?? [];
      const isNew = !current.some((candidate) => sameIdentity(candidate, message));
      const merged = mergeMessages(current, [message]);
      next.messages.set(message.chatGuid, merged);
      const reconciled = merged.find((candidate) => sameIdentity(candidate, message)) ?? message;
      touchChat(next.chats, reconciled, readingChat(next), isNew, next.readAt.get(message.chatGuid));
      return next;
    }
    case "typing": {
      const typing = new Map(state.typing);
      typing.set(event.chatGuid, event.display);
      return { ...state, typing };
    }
    case "send-requested": {
      const next = cloneState(state);
      const outgoing: Outgoing = { tempGuid: event.tempGuid, chatGuid: event.chatGuid, text: event.text, replyTo: event.replyTo ?? null, createdAt: now, phase: "sending", error: null };
      next.outbox.set(event.tempGuid, outgoing);
      const pending = pendingText(outgoing, now);
      const current = next.messages.get(event.chatGuid) ?? [];
      const isNew = !current.some((message) => sameIdentity(message, pending));
      next.messages.set(event.chatGuid, mergeMessages(current, [pending]));
      touchChat(next.chats, pending, event.chatGuid, isNew);
      const draft = next.drafts.get(event.chatGuid);
      next.drafts.set(event.chatGuid, { text: draft?.text === event.text ? "" : draft?.text ?? "", replyTo: null });
      // Sending moves the selection to the new message, which scrolls it into view.
      next.messageCursor.delete(event.chatGuid);
      return next;
    }
    case "send-acked": {
      const next = cloneState(state);
      next.outbox.delete(event.tempGuid);
      for (const [chatGuid, cursor] of next.messageCursor) if (cursor === event.tempGuid) next.messageCursor.set(chatGuid, event.guid);
      for (const [chatGuid, list] of next.messages) {
        const matched = list.filter((message) => message.kind === "text" && (message.guid === event.tempGuid || message.tempGuid === event.tempGuid));
        if (matched.length === 0) continue;
        const texts = matched.filter((message): message is TextMessage => message.kind === "text");
        const first = texts[0];
        if (!first) continue;
        const base = texts.slice(1).reduce(mergeText, first);
        const acked: TextMessage = { ...base, guid: event.guid, tempGuid: event.tempGuid, status: statusRank[base.status] > statusRank.sent ? base.status : "sent" };
        next.messages.set(chatGuid, mergeMessages(list.filter((message) => !matched.includes(message)), [acked]));
      }
      return next;
    }
    case "send-failed": {
      const next = cloneState(state);
      const outgoing = next.outbox.get(event.tempGuid);
      if (outgoing) next.outbox.set(event.tempGuid, { ...outgoing, phase: event.uncertain ? "uncertain" : "failed", error: event.error });
      for (const [chatGuid, list] of next.messages) next.messages.set(chatGuid, list.map((message) => message.kind === "text" && (message.guid === event.tempGuid || message.tempGuid === event.tempGuid) && statusRank[message.status] === 0 ? { ...message, status: event.uncertain ? "uncertain" : "failed" } : message));
      return next;
    }
    case "read-succeeded": {
      const readPending = new Map(state.readPending);
      readPending.delete(event.chatGuid);
      return { ...state, readPending };
    }
    case "read-failed": {
      const readPending = new Map(state.readPending);
      readPending.set(event.chatGuid, event.message);
      return { ...state, readPending };
    }
    case "mark-read": {
      const chats = new Map(state.chats);
      const chat = chats.get(event.chatGuid);
      if (chat) chats.set(event.chatGuid, { ...chat, unreadCount: 0 });
      const readPending = new Map(state.readPending); readPending.delete(event.chatGuid);
      const readAt = new Map(state.readAt); readAt.set(event.chatGuid, now);
      return { ...state, chats, readPending, readAt };
    }
    case "restore": {
      const next = cloneState(state);
      for (const [guid, draft] of event.saved.drafts) next.drafts.set(guid, draft);
      for (const [guid, at] of event.saved.readAt) next.readAt.set(guid, at);
      for (const saved of event.saved.outbox) {
        const outgoing = saved.phase === "sending" ? { ...saved, phase: "uncertain" as const } : saved;
        next.outbox.set(outgoing.tempGuid, outgoing);
        const pending = pendingText(outgoing, now);
        next.messages.set(outgoing.chatGuid, mergeMessages(next.messages.get(outgoing.chatGuid) ?? [], [pending]));
        touchChat(next.chats, pending, next.selected, false);
      }
      return next;
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
