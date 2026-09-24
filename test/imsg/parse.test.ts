import { describe, expect, it } from "vitest";
import { parseChat, parseMessageRecord, parseStatus } from "../../src/imsg/parse.ts";

const dm = "iMessage;-;+15551230001";

function record(fields: Record<string, unknown>) {
  return { id: 10, chat_id: 1, chat_guid: dm, chat_identifier: "+15551230001", guid: "msg-1", sender: "+15551230001", is_from_me: false, text: "hi", created_at: "2026-09-24T12:00:00.000Z", attachments: [], reactions: [], ...fields };
}

describe("imsg chats", () => {
  it("names a direct chat from Contacts and keeps its database id and unread count", () => {
    const { chat, contacts } = parseChat({ id: 42, guid: dm, identifier: "+15551230001", service: "iMessage", is_group: false, contact_name: "Jane Doe", participants: ["+15551230001"], unread_count: 3, last_message_at: "2026-09-24T12:00:00.000Z" });
    expect(chat).toMatchObject({ guid: dm, rowId: 42, kind: "dm", title: "Jane Doe", unreadCount: 3, lastActivityAt: Date.parse("2026-09-24T12:00:00.000Z") });
    expect(chat.participants[0]?.contact?.displayName).toBe("Jane Doe");
    expect(contacts.map((contact) => contact.displayName)).toEqual(["Jane Doe"]);
  });

  it("titles an unnamed group by its participants so learned names can replace them", () => {
    const { chat } = parseChat({ id: 7, guid: "iMessage;+;chat123", identifier: "chat123", service: "iMessage", is_group: true, display_name: "", participants: ["+15550001111", "a@example.com"], unread_count: 0, last_message_at: "2026-09-24T12:00:00.000Z" });
    expect(chat.title).toBe("+15550001111, a@example.com");
    expect(chat.kind).toBe("group");
  });

  it("strips terminal controls from group names", () => {
    const { chat } = parseChat({ id: 8, guid: "iMessage;+;chat9", identifier: "chat9", service: "iMessage", is_group: true, display_name: "Evil\x1b]0;TITLE\x07Group", participants: [], unread_count: 0 });
    expect(chat.title).toBe("Evil]0;TITLEGroup");
  });

  it("takes the service from a service-specific GUID and only guesses it for a merged chat", () => {
    const row = { id: 9, identifier: "+15550009999", is_group: false, participants: ["+15550009999"], unread_count: 0 };
    expect(parseChat({ ...row, guid: "iMessage;-;+15550009999", service: "SMS" }).chat.service).toBe("iMessage");
    expect(parseChat({ ...row, guid: "SMS;-;+15550009999", service: "iMessage" }).chat.service).toBe("SMS");
    const merged = parseChat({ ...row, guid: "any;-;+15550009999", service: "SMS" }).chat;
    expect(merged.service).toBe("SMS");
    expect(merged.serviceAt).toBeUndefined();
    const record = parseMessageRecord({ id: 1, guid: "m", chat_guid: "any;-;+15550009999", sender: "+15550009999", is_from_me: false, text: "hi", created_at: "2026-09-24T12:00:00.000Z" });
    expect(record.messages[0]).toMatchObject({ from: { service: "iMessage" } });
  });
});

describe("imsg messages", () => {
  it("removes escape sequences, bells, and carriage returns and expands tabs", () => {
    const parsed = parseMessageRecord(record({ text: "click \x1b]8;;https://evil.example/\x1b\\https://apple.com\x1b]8;;\x1b\\ now\x07\r\nnext\tcol" }));
    const message = parsed.messages[0];
    expect(message?.kind === "text" && message.body).toBe("click ]8;;https://evil.example/\\https://apple.com]8;;\\ now\nnext    col");
  });

  it("drops the payload files behind link previews and iMessage apps, keeping real attachments' GUIDs", () => {
    const payload = (name: string, bytes: number) => ({ filename: `~/Library/Messages/Attachments/ab/${name}`, transfer_name: name, uti: "dyn.ah62d4rv4ge81k4puqe", mime_type: "", total_bytes: bytes, original_path: `/Users/me/Library/Messages/Attachments/ab/${name}`, missing: false });
    const record = parseMessageRecord({
      id: 7, guid: "link", chat_guid: "any;-;+15550009999", sender: "+15550009999", is_from_me: false,
      text: "https://open.spotify.com/track/1qnELnw7Cw9Vdjj2p97YpC", created_at: "2026-09-24T12:00:00.000Z",
      balloon_bundle_id: "com.apple.messages.URLBalloonProvider",
      attachments: [payload("8121E865-608B-4A19-98D9-FC8EDBEC5DD8.pluginPayloadAttachment", 1_024), payload("9FE887CC-7CE5-4C83-A3C1-F2DE10E53DC3.pluginPayloadAttachment", 75_000),
        { filename: "photo.jpg", transfer_name: "photo.jpg", mime_type: "image/jpeg", total_bytes: 900, original_path: "/tmp/photo.jpg", missing: false }],
    });
    expect(record.messages[0]).toMatchObject({ balloon: "com.apple.messages.URLBalloonProvider", attachments: [{ guid: "link/2", name: "photo.jpg" }] });
  });

  it("maps attachments to local paths and flags ones Messages has not downloaded", () => {
    const parsed = parseMessageRecord(record({ text: "", attachments: [
      { filename: "~/Library/Messages/Attachments/a/b/IMG_1.HEIC", transfer_name: "IMG_1.HEIC", mime_type: "image/heic", total_bytes: 2048, original_path: "/Users/me/Library/Messages/Attachments/a/b/IMG_1.HEIC", missing: false },
      { filename: "clip.mov", transfer_name: "clip.mov", mime_type: "video/quicktime", total_bytes: 9, original_path: "", missing: true },
    ] }));
    const message = parsed.messages[0];
    if (message?.kind !== "text") throw new Error("expected text");
    expect(message.attachments).toEqual([
      { guid: "msg-1/0", name: "IMG_1.HEIC", mime: "image/heic", bytes: 2048, path: "/Users/me/Library/Messages/Attachments/a/b/IMG_1.HEIC", missing: false },
      { guid: "msg-1/1", name: "clip.mov", mime: "video/quicktime", bytes: 9, missing: true },
    ]);
  });

  it("expands the reaction snapshot into tapbacks keyed by reaction row", () => {
    const parsed = parseMessageRecord(record({ reactions: [
      { id: 55, type: "emphasis", emoji: "‼️", sender: "+15551230001", sender_name: "Jane Doe", is_from_me: false, created_at: "2026-09-24T12:01:00.000Z" },
      { id: 56, type: "custom", emoji: "🎉", sender: "+15551230001", is_from_me: true, created_at: "2026-09-24T12:02:00.000Z" },
    ] }));
    expect(parsed.messages.slice(1)).toMatchObject([
      { kind: "tapback", guid: "r:55", target: "msg-1", reaction: "emphasize", isFromMe: false, removed: false },
      { kind: "tapback", guid: "r:56", target: "msg-1", reaction: "emoji", emoji: "🎉", isFromMe: true, removed: false },
    ]);
    expect(parsed.contacts.map((contact) => contact.displayName)).toEqual(["Jane Doe"]);
  });

  it("maps a live reaction event onto the same GUID as its snapshot entry", () => {
    const parsed = parseMessageRecord(record({ id: 55, guid: "reaction-row", text: "Emphasized “hi”", is_reaction: true, reaction_type: "emphasis", is_reaction_add: false, reacted_to_guid: "p:0/msg-1" }));
    expect(parsed.messages).toMatchObject([{ kind: "tapback", guid: "r:55", target: "msg-1", reaction: "emphasize", removed: true }]);
    expect(parsed.rowId).toBe(55);
  });

  it("reads replies and uses the local user for self-sent rows without a sender", () => {
    const parsed = parseMessageRecord(record({ is_from_me: true, sender: "", reply_to_guid: "p:1/parent" }));
    const message = parsed.messages[0];
    expect(message?.kind === "text" && message.from.address).toBe("me");
    expect(message?.kind === "text" && message.replyTo).toBe("parent");
    expect(parsed.contacts).toEqual([]);
  });

  it("rejects rows without a usable chat or timestamp", () => {
    expect(() => parseMessageRecord(record({ chat_guid: "" }))).toThrow(/chat guid/);
    expect(() => parseMessageRecord(record({ created_at: "never" }))).toThrow(/timestamp/);
  });
});

describe("imsg status", () => {
  it("reports database and bridge readiness", () => {
    expect(parseStatus({ version: "0.15.9", database: { ready: false, error: "unable to open database file" }, bridge: { ready: false }, methods: ["status"] }))
      .toEqual({ version: "0.15.9", databaseReady: false, databaseError: "unable to open database file", bridgeReady: false, methods: ["status"] });
  });
});
