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
    attachments: [],
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
    state = reduce(state, { type: "open-chat", chatGuid });
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
    state = reduce(state, { type: "open-chat", chatGuid });
    expect(state.chats.get(chatGuid)?.unreadCount).toBe(0);
  });

  it("applies contact display names onto DM titles", () => {
    let state = emptyState();
    state = reduce(state, {
      type: "chats-loaded",
      chats: [
        {
          guid: chatGuid,
          kind: "dm",
          service: "iMessage",
          title: "+15551234567",
          participants: [{ address: parseHandleAddress("+15551234567"), service: "iMessage" }],
          unreadCount: 0,
          muted: false,
        },
      ],
    });
    expect(state.chats.get(chatGuid)?.title).toBe("+15551234567");
    state = reduce(state, {
      type: "contacts-loaded",
      contacts: [
        {
          displayName: "Jane Doe",
          phones: [parseHandleAddress("+15551234567")],
          emails: [],
        },
      ],
    });
    expect(state.chats.get(chatGuid)?.title).toBe("Jane Doe");
  });

  it("matches formatted phones and email case without guessing country codes", () => {
    let state = emptyState();
    const formattedGuid = parseChatGuid("iMessage;+;+15551234567");
    const emailGuid = parseChatGuid("iMessage;+;jane.doe@example.com");
    const localGuid = parseChatGuid("iMessage;+;5551234567");
    state = reduce(state, { type: "chats-loaded", chats: [
      { guid: formattedGuid, kind: "dm", service: "iMessage", title: "+15551234567", participants: [{ address: parseHandleAddress("+15551234567"), service: "iMessage" }], unreadCount: 0, muted: false },
      { guid: emailGuid, kind: "dm", service: "iMessage", title: "jane.doe@example.com", participants: [{ address: parseHandleAddress("jane.doe@example.com"), service: "iMessage" }], unreadCount: 0, muted: false },
      { guid: localGuid, kind: "dm", service: "iMessage", title: "5551234567", participants: [{ address: parseHandleAddress("5551234567"), service: "iMessage" }], unreadCount: 0, muted: false },
    ] });
    state = reduce(state, { type: "contacts-loaded", contacts: [{
      displayName: "Jane Doe",
      phones: [parseHandleAddress("+1 (555) 123-4567")],
      emails: [parseHandleAddress("Jane.Doe@Example.COM")],
    }] });
    expect(state.chats.get(formattedGuid)?.title).toBe("Jane Doe");
    expect(state.chats.get(emailGuid)?.title).toBe("Jane Doe");
    expect(state.chats.get(localGuid)?.title).toBe("5551234567");
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
