import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("shows the newest conversation at startup and each highlighted one after it, marking none read", async () => {
    const sam = parseChatGuid("SMS;-;+15551230002");
    const { fake, session } = fakeSession({ bridge: true });
    try {
      await session.start();
      await eventually(() => session.getSnapshot().history.get(jane)?.kind === "ready");
      expect(session.getSnapshot()).toMatchObject({ selected: jane, input: { kind: "list" } });
      expect(texts(session).map((message) => message.body)).toEqual(["Hey", "You coming tonight?"]);
      session.act({ type: "move-list", delta: 1 });
      expect(session.getSnapshot().selected).toBe(sam);
      await eventually(() => session.getSnapshot().history.get(sam)?.kind === "ready");
      expect(texts(session, sam).map((message) => message.body)).toEqual(["Parking is around back"]);
      // Only opening a conversation reads it, which with the bridge tells the sender.
      expect(session.getSnapshot().chats.get(jane)?.unreadCount).toBe(1);
      expect(fake.requests.some((request) => request.method === "read")).toBe(false);
      session.act({ type: "move-list", delta: -1 });
      session.act({ type: "open-chat", chatGuid: jane });
      await eventually(() => fake.requests.some((request) => request.method === "read"));
      expect(fake.requests.filter((request) => request.method === "read").map((request) => request.params.chat_guid)).toEqual([jane]);
      expect(session.getSnapshot().chats.get(jane)?.unreadCount).toBe(0);
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
      expect(session.getSnapshot().unavailable).toMatch(/Allow full disk access for remote users/);
      fake.databaseReady = true;
      session.act({ type: "refresh" });
      await eventually(() => session.getSnapshot().connection === "online" && session.getSnapshot().chats.size === 3);
      expect(session.getSnapshot().unavailable).toBeNull();
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

  it("labels a merged conversation by its newest message, not the chat row's stale service", async () => {
    const wife = "+15550009999";
    const merged = parseChatGuid(`any;-;${wife}`);
    const shortCode = parseChatGuid("any;-;4735");
    const { fake, session } = fakeSession({
      chats: [
        { id: 1, guid: merged, identifier: wife, service: "SMS", is_group: false, contact_name: "Wife", participants: [wife], unread_count: 0 },
        { id: 2, guid: shortCode, identifier: "4735", service: "iMessage", is_group: false, participants: ["4735"], unread_count: 0 },
      ],
      messages: [
        { id: 1, chat_id: 1, guid: "years-ago", sender: wife, is_from_me: false, text: "before her iPhone", created_at: Date.now() - 86_400_000, service: "SMS" },
        { id: 2, chat_id: 1, guid: "latest", sender: wife, is_from_me: false, text: "Hi", created_at: Date.now() - 60_000, service: "iMessage" },
        { id: 3, chat_id: 2, guid: "code", sender: "4735", is_from_me: false, text: "Your code is 1234", created_at: Date.now() - 120_000, service: "SMS" },
      ],
    });
    try {
      await session.start();
      await eventually(() => session.getSnapshot().chats.get(merged)?.service === "iMessage" && session.getSnapshot().chats.get(shortCode)?.service === "SMS");
      // A refreshed list brings back the stored service; what the newest message showed stays.
      session.act({ type: "refresh" });
      await eventually(() => fake.requests.filter((request) => request.method === "chats.list").length === 2);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(session.getSnapshot().chats.get(merged)?.service).toBe("iMessage");
      // A newer message over the other service relabels the conversation.
      fake.deliver({ chat_id: 1, guid: "no-data", sender: wife, is_from_me: false, text: "no data here", created_at: Date.now(), service: "SMS" });
      await eventually(() => session.getSnapshot().chats.get(merged)?.service === "SMS");
      // A burst of rows, as a replayed watch delivers, costs a few lookups and ends on the newest.
      const lookups = () => fake.requests.filter((request) => request.method === "message.send_status").length;
      const before = lookups();
      for (let index = 0; index < 30; index++) {
        fake.deliver({ chat_id: 1, guid: `burst-${index}`, sender: wife, is_from_me: false, text: `burst ${index}`, created_at: Date.now() + index, service: index === 29 ? "iMessage" : "SMS" });
      }
      await eventually(() => session.getSnapshot().chats.get(merged)?.service === "iMessage");
      expect(lookups() - before).toBeLessThanOrEqual(3);
    } finally { await session.close(); }
  });

  it("trusts a service-specific chat GUID without looking anything up", async () => {
    const { fake, session } = fakeSession();
    try {
      await session.start();
      await eventually(() => [...session.getSnapshot().chats.values()].every((chat) => chat.lastMessage));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(session.getSnapshot().chats.get(parseChatGuid("SMS;-;+15551230002"))?.service).toBe("SMS");
      expect(fake.requests.some((request) => request.method === "message.send_status")).toBe(false);
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

describe("loading in the background", () => {
  // A list long enough to need two pages, each chat merged (any;-;) so its service comes
  // from its newest message.
  const address = (index: number) => `+1555200${String(index).padStart(4, "0")}`;
  const many = (count: number): FakeImsgOptions => ({
    chats: Array.from({ length: count }, (_, index) => ({ id: index + 1, guid: `any;-;${address(index)}`, identifier: address(index), service: "SMS" as const, is_group: false, participants: [address(index)], unread_count: 0 })),
    messages: Array.from({ length: count }, (_, index) => ({ id: index + 1, chat_id: index + 1, guid: `newest-${index}`, sender: address(index), is_from_me: false, text: `hello ${index}`, created_at: Date.now() - (index + 1) * 60_000, service: "iMessage" as const })),
  });
  // Records each request as it leaves and each answer as it comes back.
  function watched(fake: FakeImsg) {
    const log: ({ sent: number; method: string; params: Record<string, unknown> } | { done: number })[] = [];
    const connect = (): RpcConnector => (events) => {
      const transport = fake.connect()({
        line: (line) => { const message = JSON.parse(line) as { id?: number; method?: string }; if (typeof message.id === "number" && !message.method) log.push({ done: message.id }); events.line(line); },
        exit: events.exit,
      });
      return { write: (line) => { const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> }; log.push({ sent: request.id, method: request.method, params: request.params }); transport.write(line); }, close: () => transport.close() };
    };
    const peak = () => { let open = 0; let most = 0; for (const entry of log) { open += "sent" in entry ? 1 : -1; most = Math.max(most, open); } return most; };
    return { log, connect, peak };
  }

  it("lists the first screenful, then the rest, and previews one chat at a time", async () => {
    const fake = new FakeImsg({ ...many(70), delays: { "messages.history": 2 } });
    const { log, connect, peak } = watched(fake);
    const session = createSession({ connect, journal: memoryJournal() });
    let notifications = 0;
    session.subscribe(() => { notifications += 1; });
    try {
      await session.start();
      await eventually(() => [...session.getSnapshot().chats.values()].filter((chat) => chat.lastMessage).length === 70, 10_000);
      await eventually(() => session.getSnapshot().chats.get(parseChatGuid(`any;-;${address(0)}`))?.service === "iMessage");
      expect(fake.requests.filter((request) => request.method === "chats.list").map((request) => request.params.limit)).toEqual([60, 500]);
      expect(peak()).toBe(1);
      // Only the top of the list has its service looked up; the rest keep their row's until opened.
      expect(fake.requests.filter((request) => request.method === "message.send_status")).toHaveLength(40);
      expect(session.getSnapshot().chats.get(parseChatGuid(`any;-;${address(69)}`))?.service).toBe("SMS");
      // Seventy previews redraw the list a handful of times, not seventy.
      expect(notifications).toBeLessThan(25);
      expect(log.length).toBeGreaterThan(0);
    } finally { await session.close(); }
  });

  it("sends nothing in the background while a conversation it is opening loads", async () => {
    const fake = new FakeImsg({ ...many(70), delays: { "messages.history": 15 } });
    const { log, connect } = watched(fake);
    const session = createSession({ connect, journal: memoryJournal() });
    const deep = parseChatGuid(`any;-;${address(65)}`);
    try {
      await session.start();
      await eventually(() => [...session.getSnapshot().chats.values()].filter((chat) => chat.lastMessage).length >= 3);
      await eventually(() => session.getSnapshot().chats.has(deep), 10_000);
      session.act({ type: "open-chat", chatGuid: deep });
      await eventually(() => session.getSnapshot().history.get(deep)?.kind === "ready", 10_000);
      const opened = log.findIndex((entry) => "sent" in entry && entry.method === "messages.history" && entry.params.limit === 50 && entry.params.chat_id === 66);
      const request = log[opened] as { sent: number };
      const answered = log.findIndex((entry) => "done" in entry && entry.done === request.sent);
      expect(opened).toBeGreaterThan(0);
      expect(log.slice(opened + 1, answered).filter((entry) => "sent" in entry && entry.method !== "read")).toEqual([]);
      expect(texts(session, deep).map((message) => message.body)).toEqual(["hello 65"]);
    } finally { await session.close(); }
  });

  it("loads one conversation shown beside the list at a time, then wherever the highlight is", async () => {
    const fake = new FakeImsg({ ...many(70), delays: { "messages.history": 30 } });
    const session = createSession({ connect: () => fake.connect(), journal: memoryJournal() });
    const chat = (index: number) => parseChatGuid(`any;-;${address(index)}`);
    const pages = () => fake.requests.filter((request) => request.method === "messages.history" && request.params.limit === 50).map((request) => request.params.chat_id);
    try {
      await session.start();
      await eventually(() => session.getSnapshot().history.get(chat(0))?.kind === "ready", 5_000);
      // Held down, j moves faster than a page arrives: the ones it passed are never asked for.
      for (let index = 0; index < 5; index++) session.act({ type: "move-list", delta: 1 });
      expect(session.getSnapshot().selected).toBe(chat(5));
      await eventually(() => session.getSnapshot().history.get(chat(5))?.kind === "ready", 5_000);
      expect(pages()).toEqual([1, 2, 6]);
      expect([2, 3, 4].map((index) => session.getSnapshot().history.has(chat(index)))).toEqual([false, false, false]);
      // Opening one never waits behind a page loading for the list.
      session.act({ type: "move-list", delta: 1 });
      session.act({ type: "move-list", delta: 1 });
      session.act({ type: "open-chat", chatGuid: chat(7) });
      expect(pages()).toEqual([1, 2, 6, 7, 8]);
      await eventually(() => session.getSnapshot().history.get(chat(7))?.kind === "ready", 5_000);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(pages()).toEqual([1, 2, 6, 7, 8]);
    } finally { await session.close(); }
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

describe("opening links", () => {
  function linkSession(ssh: boolean) {
    const opened: string[] = [];
    const copied: string[] = [];
    const session = createSession({
      connect: () => new FakeImsg().connect(), journal: memoryJournal(), ssh,
      openLink: async (url) => { opened.push(url); },
      clipboard: (text) => { copied.push(text); },
    });
    return { session, opened, copied };
  }

  it("opens a link in this Mac's browser in a local session", async () => {
    const { session, opened, copied } = linkSession(false);
    session.act({ type: "open-link", url: "https://example.com/a" });
    await eventually(() => session.getSnapshot().notice !== null);
    expect(opened).toEqual(["https://example.com/a"]);
    expect(copied).toEqual([]);
    expect(session.getSnapshot().notice).toEqual({ kind: "info", text: "Opened in your browser" });
    await session.close();
  });

  it("copies the link to the SSH user's clipboard instead of opening it on the Mac", async () => {
    const { session, opened, copied } = linkSession(true);
    session.act({ type: "open-link", url: "https://example.com/b" });
    await eventually(() => session.getSnapshot().notice !== null);
    expect(opened).toEqual([]);
    expect(copied).toEqual(["https://example.com/b"]);
    expect(session.getSnapshot().notice?.text).toMatch(/Link copied/);
    await session.close();
  });

  it("refuses anything but a web link", async () => {
    const { session, opened } = linkSession(false);
    session.act({ type: "open-link", url: "file:///etc/passwd" });
    await eventually(() => session.getSnapshot().notice !== null);
    expect(opened).toEqual([]);
    expect(session.getSnapshot().notice).toEqual({ kind: "error", text: "Only web links can be opened." });
    await session.close();
  });
});

describe("notices", () => {
  it("give the key hints back after five seconds, errors after ten", async () => {
    vi.useFakeTimers();
    const session = createSession({ connect: () => new FakeImsg().connect(), journal: memoryJournal() });
    try {
      session.act({ type: "notice", notice: { kind: "info", text: "Saved at /tmp/photo.png" } });
      vi.advanceTimersByTime(4_999);
      expect(session.getSnapshot().notice?.text).toBe("Saved at /tmp/photo.png");
      vi.advanceTimersByTime(1);
      expect(session.getSnapshot().notice).toBeNull();
      session.act({ type: "notice", notice: { kind: "error", text: "Could not save" } });
      vi.advanceTimersByTime(9_999);
      expect(session.getSnapshot().notice?.text).toBe("Could not save");
      vi.advanceTimersByTime(1);
      expect(session.getSnapshot().notice).toBeNull();
      // A newer notice gets its full time, whatever was left of the one before.
      session.act({ type: "notice", notice: { kind: "info", text: "first" } });
      vi.advanceTimersByTime(4_000);
      session.act({ type: "notice", notice: { kind: "info", text: "second" } });
      vi.advanceTimersByTime(4_000);
      expect(session.getSnapshot().notice?.text).toBe("second");
      vi.advanceTimersByTime(1_000);
      expect(session.getSnapshot().notice).toBeNull();
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  it("come and go while the explanation of missing access stays", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fake, session } = fakeSession({ databaseReady: false }, { ssh: true });
    try {
      // The fake imsg answers on timers, which waitFor advances between checks.
      const started = session.start();
      await vi.waitFor(() => expect(session.getSnapshot().connection).toBe("no-access"));
      await started;
      // With no conversation open, the explanation is on screen and needs no notice.
      expect(session.getSnapshot().notice).toBeNull();
      session.act({ type: "notice", notice: { kind: "info", text: "Light mode · Shift+L for dark" } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(session.getSnapshot().notice).toBeNull();
      expect(session.getSnapshot().unavailable).toMatch(/Allow full disk access/);
      fake.databaseReady = true;
      session.act({ type: "refresh" });
      await vi.waitFor(() => expect(session.getSnapshot().connection).toBe("online"));
      expect(session.getSnapshot().unavailable).toBeNull();
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });
});
