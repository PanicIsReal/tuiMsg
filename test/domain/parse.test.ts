import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChatGuid } from "../../src/domain/ids.ts";
import {
  parseChat,
  parseContact,
  parseMessage,
  parseMessageList,
} from "../../src/domain/parse.ts";

const dir = dirname(fileURLToPath(import.meta.url));

describe("parseChat", () => {
  it("parses a fixture DM", () => {
    const raw = JSON.parse(
      readFileSync(join(dir, "../fixtures/bb/chat.json"), "utf8"),
    );
    const chat = parseChat(raw);
    expect(chat.guid).toBe("iMessage;+;+15551234567");
    expect(chat.kind).toBe("dm");
    expect(chat.service).toBe("iMessage");
    expect(chat.unreadCount).toBe(1);
    expect(chat.lastMessage?.body).toBe("Hello from BlueBubbles");
  });

  it("treats style 43 as group", () => {
    const chat = parseChat({
      guid: "iMessage;+;chatabc",
      style: 43,
      displayName: "Weekend",
      participants: [
        { address: "+1", service: "iMessage" },
        { address: "+2", service: "iMessage" },
      ],
    });
    expect(chat.kind).toBe("group");
    expect(chat.title).toBe("Weekend");
  });

  it("uses attachment names for an attachment-only latest message", () => {
    const chat = parseChat({
      guid: "iMessage;+;+15551234567",
      style: 45,
      participants: [{ address: "+15551234567" }],
      lastMessage: {
        guid: "attachment-only",
        text: "",
        dateCreated: 1,
        attachments: [{ guid: "photo", transferName: "IMG_0042.jpeg" }],
      },
    });
    expect(chat.lastMessage?.body).toBe("[IMG_0042.jpeg]");
  });
});

describe("parseContact", () => {
  it("parses macOS contact arrays and falls back from an empty display name", () => {
    expect(parseContact({
      displayName: "",
      firstName: "  Jane ",
      lastName: " Doe  ",
      phoneNumbers: [{ address: "+1 (555) 123-4567" }, "+44 20 7946 0958"],
      emails: [{ address: "Jane.Doe@Example.COM" }],
      addresses: [{ address: "backup@example.com" }, { address: "780 555 0100" }],
    })).toEqual({
      displayName: "Jane Doe",
      phones: ["+1 (555) 123-4567", "+44 20 7946 0958", "780 555 0100"],
      emails: ["Jane.Doe@Example.COM", "backup@example.com"],
    });
  });
});

describe("parseMessage", () => {
  it("parses text and receipts", () => {
    const message = parseMessage({
      guid: "abc",
      text: "hi",
      isFromMe: true,
      dateCreated: 10,
      dateDelivered: 11,
      dateRead: 12,
      handle: { address: "me", service: "iMessage" },
      chats: [{ guid: "iMessage;+;+15551234567" }],
    });
    expect(message?.kind).toBe("text");
    if (message?.kind !== "text") return;
    expect(message.status).toBe("read");
    expect(message.body).toBe("hi");
  });

  it("preserves legitimate UUID-only bodies", () => {
    const message = parseMessage({
      guid: "abc",
      text: "3F2A1B4C-9D8E-4F7A-B6C2-E8D0A1234567",
      isFromMe: false,
      dateCreated: 1,
      handle: { address: "+1", service: "iMessage" },
      chats: [{ guid: "iMessage;+;+15551234567" }],
    });
    expect(message?.kind).toBe("text");
    if (message?.kind === "text")
      expect(message.body).toBe("3F2A1B4C-9D8E-4F7A-B6C2-E8D0A1234567");
  });

  it("preserves text and every attachment", () => {
    const message = parseMessage({
      guid: "with-files",
      text: "caption",
      dateCreated: 2,
      isFromMe: false,
      sender: { address: "+1" },
      chats: [{ guid: "SMS;+;+1", service: "SMS" }],
      attachments: [
        {
          guid: "a1",
          transferName: "one.png",
          mimeType: "image/png",
          totalBytes: 12,
        },
        { guid: "a2", name: "two.pdf", mime: "application/pdf", bytes: 34 },
      ],
    });
    expect(message?.kind).toBe("text");
    if (message?.kind === "text") {
      expect(message.body).toBe("caption");
      expect(message.attachments).toHaveLength(2);
      expect(message.from.service).toBe("SMS");
    }
  });

  it("maps tapback associatedMessageType", () => {
    const message = parseMessage({
      guid: "tap",
      text: "",
      isFromMe: true,
      dateCreated: 1,
      associatedMessageType: 2000,
      associatedMessageGuid: "p:0/TARGET",
      handle: { address: "me", service: "iMessage" },
      chats: [{ guid: "iMessage;+;+15551234567" }],
    });
    expect(message?.kind).toBe("tapback");
    if (message?.kind !== "tapback") return;
    expect(message.reaction).toBe("love");
    expect(message.removed).toBe(false);
  });
});

describe("parseChatGuid", () => {
  it("rejects junk", () => {
    expect(() => parseChatGuid("not-a-guid")).toThrow(/invalid chat guid/);
  });
});

it("contains malformed list entries and reports diagnostics", () => {
  const diagnostics: string[] = [];
  const messages = parseMessageList(
    {
      data: [
        { guid: "bad", text: "x" },
        {
          guid: "ok",
          text: "y",
          dateCreated: 1,
          chats: [{ guid: "iMessage;+;+1" }],
        },
      ],
    },
    (item) => diagnostics.push(item.error),
  );
  expect(messages.map((message) => message.guid)).toEqual(["ok"]);
  expect(diagnostics[0]).toMatch(/chat guid/);
});
