import { describe, expect, it } from "vitest";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../../src/domain/ids.ts";
import { emptyState, type TextMessage } from "../../src/domain/model.ts";
import { reduce } from "../../src/domain/reduce.ts";

const chatGuid = parseChatGuid("iMessage;+;+15551230001");
const guid = parseMessageGuid("server-message");
const tempGuid = parseMessageGuid("local-message");
const message: TextMessage = {
  kind: "text", guid, chatGuid, sentAt: 1000,
  from: { address: parseHandleAddress("+15551230001"), service: "iMessage" },
  isFromMe: false, body: "Hello", status: "delivered", attachments: [],
};

function initialState() {
  return reduce(emptyState(), { type: "chats-loaded", chats: [{
    guid: chatGuid, kind: "dm", service: "iMessage", title: "Jane",
    participants: [message.from], unreadCount: 0, muted: false,
  }] });
}

describe("message reliability", () => {
  it("does not count duplicate incoming events as new unread messages", () => {
    const received = reduce(initialState(), { type: "message-upserted", message });
    const repeated = reduce(received, { type: "message-upserted", message });
    expect(repeated.messages.get(chatGuid)).toHaveLength(1);
    expect(repeated.chats.get(chatGuid)?.unreadCount).toBe(1);
  });

  it("preserves live messages when an older history snapshot completes", () => {
    const received = reduce(initialState(), { type: "message-upserted", message });
    const loaded = reduce(received, { type: "messages-loaded", chatGuid, messages: [] });
    expect(loaded.messages.get(chatGuid)?.map(item => item.guid)).toContain(guid);
  });

  it("preserves a read receipt when the HTTP send acknowledgement arrives last", () => {
    const pending = reduce(initialState(), { type: "send-requested", chatGuid, text: "Hello", tempGuid });
    const read = reduce(pending, { type: "message-upserted", message: {
      ...message, isFromMe: true, status: "read", readAt: 2000, tempGuid,
    } });
    const acknowledged = reduce(read, { type: "send-acked", tempGuid, guid });
    expect(acknowledged.messages.get(chatGuid)).toHaveLength(1);
    expect(acknowledged.messages.get(chatGuid)?.[0]).toMatchObject({ status: "read", readAt: 2000 });
  });
  it("does not mark previously read catch-up messages unread", () => {
    const read = reduce(initialState(), { type: "mark-read", chatGuid }, 2000);
    const caughtUp = reduce(read, { type: "message-upserted", message });
    expect(caughtUp.chats.get(chatGuid)?.unreadCount).toBe(0);
  });

  it("opens a transcript without handing navigation keys to the composer", () => {
    const opened = reduce(initialState(), { type: "open-chat", chatGuid });
    expect(opened.input).toEqual({ kind: "transcript", chatGuid });
  });

  it("preserves SMS service on optimistic messages", () => {
    const sms = parseChatGuid("SMS;+;+15551230001");
    const pending = reduce(emptyState(), { type: "send-requested", chatGuid: sms, text: "Hi", tempGuid });
    expect(pending.messages.get(sms)?.[0]).toMatchObject({ from: { service: "SMS" } });
    expect(pending.chats.get(sms)?.title).toBe("+15551230001");
  });

  it("does not restore stale unread counts from a chat snapshot", () => {
    const read = reduce(initialState(), { type: "mark-read", chatGuid }, 2000);
    const chat = read.chats.get(chatGuid)!;
    const refreshed = reduce(read, { type: "chats-loaded", chats: [{ ...chat, unreadCount: 5,
      lastMessage: { guid, sentAt: 1000, body: "Hello", isFromMe: false },
    }] });
    expect(refreshed.chats.get(chatGuid)?.unreadCount).toBe(0);
  });

  it("moves upward from the latest message when no cursor was stored", () => {
    const loaded = reduce(initialState(), { type: "messages-loaded", chatGuid, messages: [
      message, { ...message, guid: tempGuid, sentAt: 2000 },
    ] });
    const moved = reduce(loaded, { type: "move-message", chatGuid, delta: -1 });
    expect(moved.messageCursor.get(chatGuid)).toBe(guid);
  });

  it("moves the selection to a message as it is sent, and keeps it there once acknowledged", () => {
    const loaded = reduce(initialState(), { type: "messages-loaded", chatGuid, messages: [message] });
    const reading = reduce(loaded, { type: "select-message", chatGuid, messageGuid: guid });
    const sending = reduce(reading, { type: "send-requested", chatGuid, text: "On my way", tempGuid });
    // No stored cursor means the newest message, the pending one, is selected and scrolled to.
    expect(sending.messageCursor.has(chatGuid)).toBe(false);
    const picked = reduce(sending, { type: "select-message", chatGuid, messageGuid: tempGuid });
    const server = parseMessageGuid("server-reply");
    const acknowledged = reduce(picked, { type: "send-acked", tempGuid, guid: server });
    expect(acknowledged.messageCursor.get(chatGuid)).toBe(server);
  });

  it("retains the message preview when a reaction arrives", () => {
    const received = reduce(initialState(), { type: "message-upserted", message });
    const reacted = reduce(received, { type: "message-upserted", message: {
      kind: "tapback", guid: tempGuid, chatGuid, sentAt: 2000, from: message.from,
      isFromMe: false, target: guid, reaction: "love", removed: false,
    } });
    expect(reacted.chats.get(chatGuid)?.lastMessage?.body).toBe("Hello");
  });

  it("does not undo a live edit when an older snapshot arrives", () => {
    const edited = reduce(initialState(), { type: "message-upserted", message: { ...message, body: "Corrected", editedAt: 3000 } });
    const snapshot = reduce(edited, { type: "messages-loaded", chatGuid, messages: [message] });
    expect(snapshot.messages.get(chatGuid)?.[0]).toMatchObject({ body: "Corrected", editedAt: 3000 });
    const staleEvent = reduce(snapshot, { type: "message-upserted", message });
    expect(staleEvent.chats.get(chatGuid)?.lastMessage?.body).toBe("Corrected");
  });

  it("keeps fully loaded history complete after a newest-page refresh", () => {
    let state = reduce(initialState(), { type: "history-loading", chatGuid, request: 1, mode: "latest" });
    state = reduce(state, { type: "history-loaded", chatGuid, request: 1, page: { messages: [message], next: null } });
    state = reduce(state, { type: "history-loading", chatGuid, request: 2, mode: "latest" });
    state = reduce(state, { type: "history-loaded", chatGuid, request: 2, page: { messages: [message], next: { before: 1000 } } });
    expect(state.history.get(chatGuid)).toEqual({ kind: "ready", next: null });
  });

  it("counts incoming messages unread after returning to the conversation list", () => {
    const opened = reduce(initialState(), { type: "open-chat", chatGuid });
    const list = reduce(opened, { type: "input", input: { kind: "list" } });
    const received = reduce(list, { type: "message-upserted", message });
    expect(received.chats.get(chatGuid)?.unreadCount).toBe(1);
  });

});
