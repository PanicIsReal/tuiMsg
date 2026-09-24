import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChatGuid } from "../../src/domain/ids.ts";
import type { Attachment, TextMessage } from "../../src/domain/model.ts";
import { FakeImsg, type FakeImsgOptions } from "../../src/imsg/fake.ts";
import type { RpcConnector } from "../../src/imsg/rpc.ts";
import { createJournal, journalPath, type Journal } from "../../src/journal.ts";
import { createSession, type SessionOptions } from "../../src/session.ts";

const jane = parseChatGuid("iMessage;-;+15551230001");
const image: Attachment = { guid: "image-guid", name: "photo.jpg", mime: "image/jpeg", bytes: 3, path: "/tmp/photo.jpg", missing: false };

function memoryJournal(): Journal {
  return { load: async () => undefined, save: async () => undefined, flush: async () => undefined };
}

function fakeSession(options: FakeImsgOptions = {}, session: Partial<SessionOptions> = {}) {
  const fake = new FakeImsg(options);
  let connections = 0;
  const connect = (): RpcConnector => { connections += 1; return fake.connect(); };
  return { fake, connections: () => connections, session: createSession({ connect, journal: memoryJournal(), restartDelays: [10], ...session }) };
}

async function eventually(check: () => boolean, timeout = 2_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function texts(session: ReturnType<typeof createSession>, chatGuid = jane): TextMessage[] {
  return (session.getSnapshot().messages.get(chatGuid) ?? []).filter((message): message is TextMessage => message.kind === "text");
}

describe("session over imsg", () => {
  it("lists chats with names, previews, and unread counts, then opens history with reactions folded", async () => {
    const { fake, session } = fakeSession();
    try {
      await session.start();
      await eventually(() => session.getSnapshot().chats.get(jane)?.lastMessage?.body === "You coming tonight?");
      const snapshot = session.getSnapshot();
      expect(snapshot.connection).toBe("online");
      expect([...snapshot.chats.values()].map((chat) => chat.title)).toEqual(["Jane Doe", "Sam Park", "Weekend"]);
      expect(snapshot.chats.get(jane)?.unreadCount).toBe(1);
      session.act({ type: "open-chat", chatGuid: jane });
      await eventually(() => session.getSnapshot().history.get(jane)?.kind === "ready");
      expect(texts(session).map((message) => message.body)).toEqual(["Hey", "You coming tonight?"]);
      expect(session.getSnapshot().messages.get(jane)?.find((message) => message.kind === "tapback")).toMatchObject({ target: "m0", reaction: "love", isFromMe: true });
      expect(session.getSnapshot().chats.get(jane)?.unreadCount).toBe(0);
      expect(fake.requests.some((request) => request.method === "read")).toBe(false);
    } finally { await session.close(); }
  });

  it("names group members from the senders it has seen", async () => {
    const { session } = fakeSession({
      chats: [{ id: 5, guid: "iMessage;+;chat5", identifier: "chat5", service: "iMessage", is_group: true, participants: ["+15550000001", "+15550000002"], unread_count: 0 }],
      messages: [
        { id: 1, chat_id: 5, guid: "g1", sender: "+15550000001", sender_name: "Ana", is_from_me: false, text: "one", created_at: 1_000 },
        { id: 2, chat_id: 5, guid: "g2", sender: "+15550000002", sender_name: "Ben", is_from_me: false, text: "two", created_at: 2_000 },
      ],
    });
    const group = parseChatGuid("iMessage;+;chat5");
    try {
      await session.start();
      session.act({ type: "open-chat", chatGuid: group });
      await eventually(() => session.getSnapshot().chats.get(group)?.title === "Ana, Ben");
    } finally { await session.close(); }
  });

  it("sends once and merges the streamed row into the pending bubble", async () => {
    const { fake, session } = fakeSession();
    try {
      await session.start();
      session.act({ type: "open-chat", chatGuid: jane });
      await eventually(() => session.getSnapshot().history.get(jane)?.kind === "ready");
      session.act({ type: "draft-set", chatGuid: jane, text: "on my way" });
      session.act({ type: "send", chatGuid: jane });
      await eventually(() => session.getSnapshot().outbox.size === 0 && texts(session).some((message) => message.body === "on my way" && message.guid === fake.messages.at(-1)?.guid));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(texts(session).filter((message) => message.body === "on my way")).toHaveLength(1);
      expect(fake.sent).toEqual([{ chat_guid: jane, text: "on my way" }]);
      expect(session.getSnapshot().drafts.get(jane)?.text).toBe("");
    } finally { await session.close(); }
  });

  it("matches a sent row that streams in before the send result arrives", async () => {
    const { fake, session } = fakeSession({ delays: { send: 150 } });
    try {
      await session.start();
      session.act({ type: "draft-set", chatGuid: jane, text: "race" });
      session.act({ type: "send", chatGuid: jane });
      await eventually(() => session.getSnapshot().outbox.size === 0);
      const row = fake.messages.at(-1)!;
      expect(texts(session).filter((message) => message.body === "race").map((message) => message.guid)).toEqual([row.guid]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(texts(session).filter((message) => message.body === "race").map((message) => message.guid)).toEqual([row.guid]);
    } finally { await session.close(); }
  });

  it("marks an unknown delivery outcome uncertain, asks before retrying, and resolves when the row appears", async () => {
    const { fake, session } = fakeSession({ failures: { send: { code: -32001, message: "Delivery outcome unknown", data: { retry_safe: false, disposition: "may_have_completed", transport: "applescript", operation: "send", detail: "timed out waiting for Messages" } } } });
    try {
      await session.start();
      session.act({ type: "draft-set", chatGuid: jane, text: "maybe sent" });
      session.act({ type: "send", chatGuid: jane });
      await eventually(() => [...session.getSnapshot().outbox.values()].some((item) => item.phase === "uncertain"));
      const tempGuid = [...session.getSnapshot().outbox.keys()][0]!;
      session.act({ type: "retry-send", tempGuid });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.requests.filter((request) => request.method === "send")).toHaveLength(1);
      expect(session.getSnapshot().input.kind).toBe("retry-confirm");
      fake.deliver({ chat_id: 1, guid: "it-went", sender: "+15551230001", is_from_me: true, text: "maybe sent", created_at: Date.now() });
      await eventually(() => session.getSnapshot().outbox.size === 0);
      expect(texts(session).find((message) => message.body === "maybe sent")).toMatchObject({ guid: "it-went", status: "sent" });
    } finally { await session.close(); }
  });

  it("stops sending while imsg holds an unresolved send, and restarts imsg on refresh", async () => {
    const { fake, session, connections } = fakeSession({ failures: { send: { code: -32004, message: "Mutation lane blocked", data: { retry_safe: false, disposition: "still_in_flight", transport: "applescript", operation: "send", detail: "A prior send remains in flight. Restart the RPC child before sending another mutation." } } } });
    try {
      await session.start();
      session.act({ type: "draft-set", chatGuid: jane, text: "blocked" });
      session.act({ type: "send", chatGuid: jane });
      await eventually(() => [...session.getSnapshot().outbox.values()].some((item) => item.phase === "failed"));
      expect(session.getSnapshot().notice?.text).toMatch(/Mutation lane blocked/);
      fake.failures.delete("send");
      session.act({ type: "draft-set", chatGuid: jane, text: "second" });
      session.act({ type: "send", chatGuid: jane });
      await eventually(() => session.getSnapshot().notice?.text.includes("Shift+R") ?? false);
      expect(fake.requests.filter((request) => request.method === "send")).toHaveLength(1);
      session.act({ type: "refresh" });
      await eventually(() => connections() === 2 && session.getSnapshot().connection === "online");
      const failed = [...session.getSnapshot().outbox.values()].find((item) => item.text === "second")!;
      session.act({ type: "retry-send", tempGuid: failed.tempGuid });
      await eventually(() => fake.sent.some((sent) => sent.text === "second"));
    } finally { await session.close(); }
  });

  it("restarts a crashed imsg and resumes the watch without losing rows", async () => {
    const fake = new FakeImsg();
    const exits: Array<(error: Error) => void> = [];
    let connections = 0;
    const connect = (): RpcConnector => (events) => {
      connections += 1;
      const transport = fake.connect()(events);
      exits.push(events.exit);
      return transport;
    };
    const session = createSession({ connect, journal: memoryJournal(), restartDelays: [10] });
    try {
      await session.start();
      fake.receive(1, "before crash", "+15551230001", "Jane Doe");
      await eventually(() => texts(session).some((message) => message.body === "before crash"));
      exits[0]!(new Error("imsg stopped (signal SIGKILL)"));
      expect(session.getSnapshot().connection).toBe("offline");
      fake.deliver({ chat_id: 1, guid: "while-down", sender: "+15551230001", is_from_me: false, text: "while down", created_at: Date.now() });
      await eventually(() => connections === 2 && session.getSnapshot().connection === "online");
      await eventually(() => texts(session).some((message) => message.body === "while down"));
      const resumed = fake.requests.filter((request) => request.method === "watch.subscribe").at(-1);
      expect(resumed?.params.since_rowid).toBeGreaterThan(0);
    } finally { await session.close(); }
  });

  it("resubscribes from the overflow cursor without skipping the dropped row", async () => {
    const { fake, session } = fakeSession();
    try {
      await session.start();
      const cursor = Math.max(...fake.messages.map((message) => message.id));
      fake.deliver({ chat_id: 1, guid: "dropped", sender: "+15551230001", is_from_me: false, text: "dropped by overflow", created_at: Date.now() }, false);
      fake.overflow(cursor);
      await eventually(() => texts(session).some((message) => message.body === "dropped by overflow"));
      expect(fake.requests.filter((request) => request.method === "watch.subscribe").at(-1)?.params.since_rowid).toBe(cursor);
    } finally { await session.close(); }
  });

  it("explains how to grant access when the Messages database is unreadable over SSH", async () => {
    const { fake, session } = fakeSession({ databaseReady: false }, { ssh: true });
    try {
      await session.start();
      expect(session.getSnapshot().connection).toBe("no-access");
      expect(session.getSnapshot().notice?.text).toMatch(/Allow full disk access for remote users/);
      fake.databaseReady = true;
      session.act({ type: "refresh" });
      await eventually(() => session.getSnapshot().connection === "online" && session.getSnapshot().chats.size === 3);
    } finally { await session.close(); }
  });

  it("uses bridge-only features only when imsg reports the bridge", async () => {
    const plain = fakeSession({ bridge: false });
    try {
      await plain.session.start();
      plain.session.act({ type: "react", chatGuid: jane, messageGuid: "m0" as never, reaction: "love", remove: false });
      expect(plain.session.getSnapshot().notice?.text).toMatch(/imsg bridge/);
      expect(plain.fake.requests.some((request) => request.method === "tapback")).toBe(false);
    } finally { await plain.session.close(); }

    const bridged = fakeSession({ bridge: true });
    try {
      await bridged.session.start();
      bridged.session.act({ type: "open-chat", chatGuid: jane });
      await eventually(() => bridged.fake.requests.some((request) => request.method === "read"));
      bridged.session.act({ type: "react", chatGuid: jane, messageGuid: "m1" as never, reaction: "emphasize", remove: false });
      await eventually(() => bridged.fake.requests.some((request) => request.method === "tapback" && request.params.reaction === "emphasis"));
    } finally { await bridged.session.close(); }
  });

  it("discovers a chat first seen on the watch", async () => {
    const { fake, session } = fakeSession();
    try {
      await session.start();
      fake.chats.push({ id: 9, guid: "iMessage;-;new@example.com", identifier: "new@example.com", service: "iMessage", is_group: false, contact_name: "New Person", participants: ["new@example.com"], unread_count: 1 });
      fake.receive(9, "hello there", "new@example.com", "New Person");
      const guid = parseChatGuid("iMessage;-;new@example.com");
      await eventually(() => session.getSnapshot().chats.get(guid)?.title === "New Person" && session.getSnapshot().chats.get(guid)?.rowId === 9);
    } finally { await session.close(); }
  });

  it("starts a conversation with a new recipient and opens it", async () => {
    const { fake, session } = fakeSession();
    try {
      await session.start();
      session.act({ type: "input", input: { kind: "new-chat", addresses: "+15551239998", text: "First message", service: "SMS", field: "text", busy: false, error: null } });
      session.act({ type: "create-chat", addresses: "+15551239998", text: "First message", service: "SMS" });
      const guid = parseChatGuid("SMS;-;+15551239998");
      await eventually(() => session.getSnapshot().selected === guid && session.getSnapshot().history.get(guid)?.kind === "ready");
      expect(texts(session, guid).map((message) => message.body)).toEqual(["First message"]);
      expect(fake.requests.find((request) => request.method === "send")?.params).toMatchObject({ to: "+15551239998", service: "sms" });
    } finally { await session.close(); }
  });

  it("refuses group creation without the bridge and keeps the form open", async () => {
    const { fake, session } = fakeSession({ bridge: false });
    try {
      await session.start();
      session.act({ type: "input", input: { kind: "new-chat", addresses: "a@example.com, b@example.com", text: "hi all", service: "iMessage", field: "text", busy: false, error: null } });
      session.act({ type: "create-chat", addresses: "a@example.com, b@example.com", text: "hi all", service: "iMessage" });
      const input = session.getSnapshot().input;
      expect(input.kind === "new-chat" && input.error).toMatch(/imsg bridge/);
      expect(fake.requests.some((request) => request.method === "chats.create" || request.method === "send")).toBe(false);
    } finally { await session.close(); }
  });

  it("restores drafts from the journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuimsg-session-"));
    const first = fakeSession({}, { journal: createJournal(journalPath(directory)) });
    await first.session.start();
    first.session.act({ type: "draft-set", chatGuid: jane, text: "survives restart" });
    await first.session.close();

    const second = fakeSession({}, { journal: createJournal(journalPath(directory)) });
    await second.session.start();
    expect(second.session.getSnapshot().drafts.get(jane)?.text).toBe("survives restart");
    await second.session.close();
  });

  it("does not send before the pending message is durably recorded", async () => {
    const journal: Journal = {
      load: async () => undefined,
      save: async () => { throw new Error("disk full"); },
      flush: async () => { throw new Error("disk full"); },
    };
    const { fake, session } = fakeSession({}, { journal });
    await session.start();
    session.act({ type: "draft-set", chatGuid: jane, text: "must be recorded first" });
    session.act({ type: "send", chatGuid: jane });
    await eventually(() => [...session.getSnapshot().outbox.values()].some((item) => item.phase === "failed"));
    expect(fake.sent).toHaveLength(0);
    await expect(session.close()).rejects.toThrow("disk full");
  });

  it("quits promptly while imsg is still starting", async () => {
    let quitFinished = false;
    const fake = new FakeImsg({ delays: { status: 1_000 } });
    const session = createSession({
      connect: () => fake.connect(), journal: memoryJournal(),
      quit: async () => { await session.close(); quitFinished = true; },
    });
    void session.start();
    await eventually(() => fake.requests.some((request) => request.method === "status"));
    session.act({ type: "quit" });
    await eventually(() => quitFinished, 500);
  });
});

describe("attachment previews", () => {
  function previewSession(readAttachment: SessionOptions["readAttachment"]) {
    return createSession({ connect: () => new FakeImsg().connect(), journal: memoryJournal(), ...(readAttachment ? { readAttachment } : {}) });
  }

  it("shares an in-flight preview and caches the completed bytes", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = previewSession(async () => { reads += 1; await gate; return new Uint8Array([1, 2, 3]); });
    const first = session.loadAttachment(image);
    const second = session.loadAttachment(image);
    await Promise.resolve();
    expect(reads).toBe(1);
    release();
    const [firstBytes, secondBytes] = await Promise.all([first, second]);
    expect(secondBytes).toBe(firstBytes);
    expect(await session.loadAttachment(image)).toBe(firstBytes);
    expect(reads).toBe(1);
    await session.close();
  });

  it("retries a preview after a failed read", async () => {
    let reads = 0;
    const session = previewSession(async () => {
      reads += 1;
      if (reads === 1) throw new Error("temporary preview failure");
      return new Uint8Array([4, 5, 6]);
    });
    await expect(session.loadAttachment(image)).rejects.toThrow(/temporary preview failure/);
    await expect(session.loadAttachment(image)).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(reads).toBe(2);
    await session.close();
  });

  it("rejects pending and new previews when the session closes", async () => {
    const session = previewSession(async () => new Promise<Uint8Array>(() => undefined));
    const pending = session.loadAttachment(image);
    const rejected = expect(pending).rejects.toThrow(/closed/);
    await Promise.resolve();
    await session.close();
    await rejected;
    await expect(session.loadAttachment(image)).rejects.toThrow("Session is closed");
  });
});
