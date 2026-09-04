import { describe, expect, it } from "vitest";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../../src/domain/ids.ts";
import { emptyState, type TextMessage } from "../../src/domain/model.ts";
import { reduce } from "../../src/domain/reduce.ts";
import { foldTapbacks, sortedChats } from "../../src/domain/view.ts";

const chatGuid = parseChatGuid("iMessage;+;+15551234567");

function text(partial: Partial<TextMessage> & Pick<TextMessage, "guid" | "body">): TextMessage {
  return {
    kind: "text",
    chatGuid,
    sentAt: 1,
    from: { address: parseHandleAddress("+15551234567"), service: "iMessage" },
    isFromMe: false,
    tapbacks: [],
    status: "sent",
    ...partial,
  };
}

describe("reduce", () => {
  it("maps tempGuid pending to acked guid", () => {
    const temp = parseMessageGuid("temp-1");
    const final = parseMessageGuid("real-1");
    let state = emptyState();
    state = reduce(state, {
      type: "chats-loaded",
      chats: [
        {
          guid: chatGuid,
          kind: "dm",
          service: "iMessage",
          title: "Jane",
          participants: [{ address: parseHandleAddress("+15551234567"), service: "iMessage" }],
          unreadCount: 0,
          muted: false,
        },
      ],
    });
    state = reduce(state, { type: "select-chat", chatGuid });
    state = reduce(state, {
      type: "send-requested",
      chatGuid,
      text: "hello",
      tempGuid: temp,
    });
    const pending = state.messages.get(chatGuid)?.[0];
    expect(pending?.kind).toBe("text");
    if (pending?.kind === "text") expect(pending.status).toBe("pending");
    state = reduce(state, { type: "send-acked", tempGuid: temp, guid: final });
    const acked = state.messages.get(chatGuid)?.[0];
    expect(acked?.guid).toBe(final);
    if (acked?.kind === "text") expect(acked.status).toBe("sent");
  });

  it("increments unread for other chats only", () => {
    let state = emptyState();
    state = reduce(state, {
      type: "chats-loaded",
      chats: [
        {
          guid: chatGuid,
          kind: "dm",
          service: "iMessage",
          title: "Jane",
          participants: [{ address: parseHandleAddress("+15551234567"), service: "iMessage" }],
          unreadCount: 0,
          muted: false,
        },
      ],
    });
    state = reduce(state, {
      type: "message-upserted",
      message: text({ guid: parseMessageGuid("m1"), body: "yo" }),
    });
    expect(state.chats.get(chatGuid)?.unreadCount).toBe(1);
    state = reduce(state, { type: "select-chat", chatGuid });
    expect(state.chats.get(chatGuid)?.unreadCount).toBe(0);
  });
});

describe("view", () => {
  it("folds tapbacks onto the target", () => {
    const rows = foldTapbacks([
      text({ guid: parseMessageGuid("m1"), body: "hi", sentAt: 1 }),
      {
        kind: "tapback",
        guid: parseMessageGuid("t1"),
        chatGuid,
        sentAt: 2,
        target: parseMessageGuid("m1"),
        reaction: "love",
        from: { address: parseHandleAddress("me"), service: "iMessage" },
        isFromMe: true,
        removed: false,
      },
    ]);
    const msg = rows.find((r) => r.kind === "message");
    expect(msg?.kind === "message" && msg.chips[0]?.reaction).toBe("love");
  });

  it("sorts chats by last message", () => {
    const a = parseChatGuid("iMessage;+;+15551111111");
    const b = parseChatGuid("iMessage;+;+15552222222");
    const chats = new Map([
      [
        a,
        {
          guid: a,
          kind: "dm" as const,
          service: "iMessage" as const,
          title: "A",
          participants: [],
          unreadCount: 0,
          muted: false,
          lastMessage: { body: "old", sentAt: 1, isFromMe: false },
        },
      ],
      [
        b,
        {
          guid: b,
          kind: "dm" as const,
          service: "iMessage" as const,
          title: "B",
          participants: [],
          unreadCount: 0,
          muted: false,
          lastMessage: { body: "new", sentAt: 9, isFromMe: false },
        },
      ],
    ]);
    expect(sortedChats(chats, "").map((c) => c.title)).toEqual(["B", "A"]);
  });
});
