import { describe, expect, it } from "vitest";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../../src/domain/ids.ts";
import { emptyState, type Chat, type Message, type TextMessage } from "../../src/domain/model.ts";
import { reduce } from "../../src/domain/reduce.ts";
import { foldTapbacks } from "../../src/domain/view.ts";

const alice = parseHandleAddress("alice@example.com");
const bob = parseHandleAddress("bob@example.com");
const chatGuid = parseChatGuid("iMessage;+;alice@example.com");
const secondGuid = parseChatGuid("iMessage;+;bob@example.com");
const thirdGuid = parseChatGuid("iMessage;+;carol@example.com");

function chat(guid = chatGuid, title = "Alice"): Chat {
  return { guid, kind: "dm", service: "iMessage", title, participants: [{ address: guid === chatGuid ? alice : bob, service: "iMessage" }], unreadCount: 0, muted: false };
}

function text(guid: string, sentAt: number, partial: Partial<TextMessage> = {}): TextMessage {
  return { kind: "text", guid: parseMessageGuid(guid), chatGuid, sentAt, from: { address: alice, service: "iMessage" }, isFromMe: false, body: guid, attachments: [], status: "sent", ...partial };
}

describe("domain event transitions", () => {
  it("keeps list selection separate from the open conversation", () => {
    let state = reduce(emptyState(), { type: "chats-loaded", chats: [chat(), chat(secondGuid, "Bob")] });
    state = reduce(state, { type: "move-list", delta: 1 });
    expect(state.listCursor).toBe(secondGuid);
    state = reduce(state, { type: "open-chat", chatGuid });
    expect(state.selected).toBe(chatGuid);
    expect(state.listCursor).toBe(secondGuid);
  });

  it("pins the initial list cursor to the newest chat until the user moves it", () => {
    const older = { ...chat(), lastMessage: { body: "old", sentAt: 10, isFromMe: false } };
    const newer = { ...chat(secondGuid, "Bob"), lastMessage: { body: "new", sentAt: 20, isFromMe: false } };
    let state = reduce(emptyState(), { type: "chats-loaded", chats: [older] });
    state = reduce(state, { type: "chats-loaded", chats: [newer] });
    expect(state.listCursor).toBe(secondGuid);
    state = reduce(state, { type: "move-list", delta: 1 });
    expect(state.listCursor).toBe(chatGuid);
    state = reduce(state, { type: "chats-loaded", chats: [{ ...chat(thirdGuid, "Carol"), lastMessage: { body: "latest", sentAt: 30, isFromMe: false } }] });
    expect(state.listCursor).toBe(chatGuid);
  });

  it("owns draft text and replies per chat", () => {
    let state = reduce(emptyState(), { type: "draft-set", chatGuid, text: "one" });
    state = reduce(state, { type: "reply", chatGuid, messageGuid: parseMessageGuid("m1") });
    state = reduce(state, { type: "draft-set", chatGuid: secondGuid, text: "two" });
    expect(state.drafts.get(chatGuid)).toEqual({ text: "one", replyTo: parseMessageGuid("m1") });
    expect(state.drafts.get(secondGuid)).toEqual({ text: "two", replyTo: null });
  });

  it("ignores stale history completions and preserves the oldest pagination cursor on refresh", () => {
    const oldest = { before: 10, offset: 20 };
    let state = emptyState();
    state.history.set(chatGuid, { kind: "ready", next: oldest });
    state = reduce(state, { type: "history-loading", chatGuid, request: 2, mode: "latest" });
    const stale = reduce(state, { type: "history-loaded", chatGuid, request: 1, page: { messages: [text("stale", 1)], next: null, total: 1 } });
    expect(stale).toBe(state);
    state = reduce(state, { type: "history-loaded", chatGuid, request: 2, page: { messages: [text("new", 30)], next: { before: 25, offset: 5 }, total: 1 } });
    expect(state.history.get(chatGuid)).toEqual({ kind: "ready", next: oldest });
  });

  it("creates a provisional chat and never lets an older arrival replace its preview", () => {
    let state = reduce(emptyState(), { type: "message-upserted", message: text("new", 20) });
    state = reduce(state, { type: "message-upserted", message: text("old", 10) });
    expect(state.chats.get(chatGuid)).toMatchObject({ provisional: true, unreadCount: 2, lastMessage: { body: "new", sentAt: 20 } });
  });

  it("deduplicates server-first sends and keeps read receipts after acknowledgement", () => {
    const tempGuid = parseMessageGuid("temp");
    const server = text("server", 10, { isFromMe: true, status: "read", readAt: 12, tempGuid });
    let state = reduce(emptyState(), { type: "message-upserted", message: server });
    state = reduce(state, { type: "send-requested", chatGuid, text: "server", tempGuid }, 9);
    state = reduce(state, { type: "send-acked", tempGuid, guid: server.guid });
    expect(state.messages.get(chatGuid)).toHaveLength(1);
    expect(state.messages.get(chatGuid)?.[0]).toMatchObject({ guid: server.guid, status: "read", readAt: 12 });
    expect(state.outbox.has(tempGuid)).toBe(false);
  });

  it("restores sending operations as uncertain and materializes their messages", () => {
    const tempGuid = parseMessageGuid("temp");
    const state = reduce(emptyState(), { type: "restore", saved: { drafts: [], readAt: [], outbox: [{ tempGuid, chatGuid, text: "maybe", replyTo: null, createdAt: 3, phase: "sending", error: null }] } });
    expect(state.outbox.get(tempGuid)?.phase).toBe("uncertain");
    expect(state.messages.get(chatGuid)?.[0]).toMatchObject({ status: "uncertain", body: "maybe" });
  });

  it("applies contacts to loaded message senders", () => {
    let state = reduce(emptyState(), { type: "messages-loaded", chatGuid, messages: [text("m1", 1)] });
    state = reduce(state, { type: "contacts-loaded", contacts: [{ displayName: "Alice A", phones: [], emails: [alice] }] });
    const message = state.messages.get(chatGuid)?.[0];
    expect(message?.kind === "text" && message.from.contact?.displayName).toBe("Alice A");
  });
});

describe("tapback membership", () => {
  it("removes only the matching sender's reaction", () => {
    const target = text("target", 1);
    const reaction = (guid: string, address: typeof alice, removed: boolean): Message => ({ kind: "tapback", guid: parseMessageGuid(guid), chatGuid, sentAt: removed ? 4 : 2, target: target.guid, reaction: "love", from: { address, service: "iMessage" }, isFromMe: address === alice, removed });
    const rows = foldTapbacks([target, reaction("a", alice, false), reaction("b", bob, false), reaction("remove-a", alice, true)]);
    const row = rows.find((candidate) => candidate.kind === "message");
    expect(row?.kind === "message" ? row.chips : []).toEqual([{ reaction: "love", count: 1, fromMe: false }]);
  });
});
