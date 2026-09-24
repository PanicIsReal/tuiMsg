import { describe, expect, it } from "vitest";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../../src/domain/ids.ts";
import { emptyState, type Chat, type Message, type TextMessage } from "../../src/domain/model.ts";
import { reduce } from "../../src/domain/reduce.ts";
import { foldTapbacks } from "../../src/domain/view.ts";

const alice = parseHandleAddress("alice@example.com");
const bob = parseHandleAddress("bob@example.com");
const chatGuid = parseChatGuid("iMessage;+;alice@example.com");
const secondGuid = parseChatGuid("iMessage;+;bob@example.com");

function chat(guid = chatGuid, title = "Alice"): Chat {
  return { guid, kind: "dm", service: "iMessage", title, participants: [{ address: guid === chatGuid ? alice : bob, service: "iMessage" }], unreadCount: 0, muted: false };
}

function text(guid: string, sentAt: number, partial: Partial<TextMessage> = {}): TextMessage {
  return { kind: "text", guid: parseMessageGuid(guid), chatGuid, sentAt, from: { address: alice, service: "iMessage" }, isFromMe: false, body: guid, attachments: [], status: "sent", ...partial };
}

describe("domain event transitions", () => {
  it("relabels a merged chat from its newest message and keeps that across list refreshes", () => {
    const merged = parseChatGuid("any;-;alice@example.com");
    const stored: Chat = { ...chat(merged), service: "SMS" };
    let state = reduce(emptyState(), { type: "chats-loaded", chats: [stored] });
    state = reduce(state, { type: "chat-service", chatGuid: merged, service: "iMessage", at: 2_000 });
    expect(state.chats.get(merged)).toMatchObject({ service: "iMessage", serviceAt: 2_000 });
    // A lookup for an older message that resolves late does not win.
    state = reduce(state, { type: "chat-service", chatGuid: merged, service: "SMS", at: 1_000 });
    expect(state.chats.get(merged)?.service).toBe("iMessage");
    state = reduce(state, { type: "chats-loaded", chats: [stored] });
    expect(state.chats.get(merged)).toMatchObject({ service: "iMessage", serviceAt: 2_000 });
    state = reduce(state, { type: "chat-service", chatGuid: merged, service: "SMS", at: 3_000 });
    expect(state.chats.get(merged)?.service).toBe("SMS");
  });

  it("keeps list selection separate from the open conversation", () => {
    let state = reduce(emptyState(), { type: "chats-loaded", chats: [chat(), chat(secondGuid, "Bob")] });
    state = reduce(state, { type: "move-list", delta: 1 });
    expect(state.listCursor).toBe(secondGuid);
    state = reduce(state, { type: "open-chat", chatGuid });
    expect(state.selected).toBe(chatGuid);
    expect(state.listCursor).toBe(secondGuid);
  });

  it("owns draft text and replies per chat", () => {
    let state = reduce(emptyState(), { type: "draft-set", chatGuid, text: "one" });
    state = reduce(state, { type: "reply", chatGuid, messageGuid: parseMessageGuid("m1") });
    state = reduce(state, { type: "draft-set", chatGuid: secondGuid, text: "two" });
    expect(state.drafts.get(chatGuid)).toEqual({ text: "one", replyTo: parseMessageGuid("m1") });
    expect(state.drafts.get(secondGuid)).toEqual({ text: "two", replyTo: null });
  });

  it("ignores stale history completions and preserves the oldest pagination cursor on refresh", () => {
    const oldest = { before: 10 };
    let state = emptyState();
    state.history.set(chatGuid, { kind: "ready", next: oldest });
    state = reduce(state, { type: "history-loading", chatGuid, request: 2, mode: "latest" });
    const stale = reduce(state, { type: "history-loaded", chatGuid, request: 1, page: { messages: [text("stale", 1)], next: null } });
    expect(stale).toBe(state);
    state = reduce(state, { type: "history-loaded", chatGuid, request: 2, page: { messages: [text("new", 30)], next: { before: 25 } } });
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

  it("keeps your reaction and theirs apart in a direct chat where both rows carry their handle", () => {
    const target = text("dm-target", 1);
    const reaction = (guid: string, isFromMe: boolean, removed: boolean): Message => ({ kind: "tapback", guid: parseMessageGuid(guid), chatGuid, sentAt: removed ? 4 : 2, target: target.guid, reaction: "love", from: { address: bob, service: "iMessage" }, isFromMe, removed });
    const chips = (messages: Message[]) => {
      const row = foldTapbacks(messages).find((candidate) => candidate.kind === "message");
      return row?.kind === "message" ? row.chips : [];
    };
    expect(chips([target, reaction("theirs", false, false), reaction("mine", true, false)])).toEqual([{ reaction: "love", count: 2, fromMe: true }]);
    expect(chips([target, reaction("theirs", false, false), reaction("mine", true, false), reaction("theirs-off", false, true)])).toEqual([{ reaction: "love", count: 1, fromMe: true }]);
  });

  it("shows custom emoji reactions after the standard ones", () => {
    const target = text("emoji-target", 1);
    const rows = foldTapbacks([target,
      { kind: "tapback", guid: parseMessageGuid("party"), chatGuid, sentAt: 2, target: target.guid, reaction: "emoji", emoji: "🎉", from: { address: bob, service: "iMessage" }, isFromMe: false, removed: false },
      { kind: "tapback", guid: parseMessageGuid("like"), chatGuid, sentAt: 3, target: target.guid, reaction: "like", from: { address: alice, service: "iMessage" }, isFromMe: false, removed: false },
    ]);
    const row = rows.find((candidate) => candidate.kind === "message");
    expect(row?.kind === "message" ? row.chips : []).toEqual([{ reaction: "like", count: 1, fromMe: false }, { reaction: "emoji", emoji: "🎉", count: 1, fromMe: false }]);
  });
});
