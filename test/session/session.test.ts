import { afterEach, describe, expect, it } from "vitest";
import { FakeBb, type FakeChat, type FakeMessage } from "../../src/bb/fake.ts";
import { BbClient } from "../../src/bb/rest.ts";
import { parseChatGuid } from "../../src/domain/ids.ts";
import type { AppEvent, Attachment, HttpUrl } from "../../src/domain/model.ts";
import { createJournal } from "../../src/journal.ts";
import type { Journal } from "../../src/journal.ts";
import { parseHttpUrl } from "../../src/links.ts";
import { createSession, type SessionOptions } from "../../src/session.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const servers: FakeBb[] = [];
const image: Attachment = { guid: "image-guid", name: "photo.jpg", mime: "image/jpeg", bytes: 3 };
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

function memoryJournal(): Journal {
  return { load: async () => undefined, save: async () => undefined, flush: async () => undefined };
}

function fakeChat(index: number, lastMessage?: FakeMessage): FakeChat {
  const address = `+1555${String(index).padStart(7, "0")}`;
  return {
    guid: `iMessage;+;${address}`,
    style: 45,
    displayName: "",
    unreadCount: 0,
    participants: [{ address, service: "iMessage" }],
    ...(lastMessage ? { lastMessage } : {}),
  };
}

function controlledSocket(): {
  connectSocket: NonNullable<SessionOptions["connectSocket"]>;
  dispatch: (event: AppEvent) => void;
} {
  let current: (event: AppEvent) => void = () => undefined;
  const connectSocket: NonNullable<SessionOptions["connectSocket"]> = (args) => {
    current = args.handlers.dispatch;
    return { close: () => undefined };
  };
  return { connectSocket, dispatch: (event) => current(event) };
}

async function fakeSession(options: ConstructorParameters<typeof FakeBb>[0] = {}) {
  const fake = new FakeBb(options);
  servers.push(fake);
  await fake.listen(0);
  const session = createSession({ url: fake.url, password: fake.password, journal: memoryJournal() });
  return { fake, session };
}

async function eventually(check: () => boolean, timeout = 2_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("session", () => {
  it.each(["7805550123", "+7805550123", "17805550123", "+17805550123"])("uses the saved contact name for %s through the BlueBubbles connection", async address => {
    const guid = parseChatGuid(`iMessage;+;${address}`);
    const message: FakeMessage = { guid: "contact-format-message", chatGuid: guid, text: "Contact format check", isFromMe: false, dateCreated: Date.now(), handle: { address, service: "iMessage" } };
    const { session } = await fakeSession({
      contacts: [{ displayName: "Alberta Contact", phoneNumbers: [{ address: "(780) 555-0123" }] }],
      chats: [{ guid, style: 45, displayName: "", unreadCount: 0, participants: [{ address, service: "iMessage" }], lastMessage: message }],
      messages: { [guid]: [message] },
    });
    try {
      await session.start();
      await eventually(() => session.getSnapshot().chats.get(guid)?.title === "Alberta Contact");
      session.act({ type: "open-chat", chatGuid: guid });
      await eventually(() => Boolean(session.getSnapshot().messages.get(guid)?.length));
      const loaded = session.getSnapshot().messages.get(guid)?.[0];
      expect(loaded?.kind === "text" && loaded.from.contact?.displayName).toBe("Alberta Contact");
      expect(loaded?.kind === "text" && loaded.from.address).toBe(address);
      expect(session.getSnapshot().chats.get(guid)?.participants[0]?.address).toBe(address);
    } finally { await session.close(); }
  });

  it("shares an in-flight image preview and caches the completed bytes", async () => {
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async () => {
        requests += 1;
        await gate;
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    const session = createSession({ url: client.url, password: "pw", client, journal: memoryJournal() });
    const first = session.loadAttachment(image);
    const second = session.loadAttachment(image);
    await Promise.resolve();
    expect(requests).toBe(1);
    release();
    const [firstBytes, secondBytes] = await Promise.all([first, second]);
    expect(secondBytes).toBe(firstBytes);
    expect(await session.loadAttachment(image)).toBe(firstBytes);
    expect(requests).toBe(1);
    await session.close();
  });

  it("retries an image preview after a failed fetch", async () => {
    let requests = 0;
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async () => {
        requests += 1;
        if (requests === 1) throw new Error("temporary preview failure");
        return new Response(new Uint8Array([4, 5, 6]));
      },
    });
    const session = createSession({ url: client.url, password: "pw", client, journal: memoryJournal() });
    await expect(session.loadAttachment(image)).rejects.toThrow(/temporary preview failure/);
    await expect(session.loadAttachment(image)).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(requests).toBe(2);
    await session.close();
  });

  it("rejects pending and new image previews when the session closes", async () => {
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      timeoutMs: 60_000,
      fetch: async () => new Promise<Response>(() => undefined),
    });
    const session = createSession({ url: client.url, password: "pw", client, journal: memoryJournal() });
    const pending = session.loadAttachment(image);
    const rejected = expect(pending).rejects.toThrow(/closed/);
    await Promise.resolve();
    await session.close();
    await rejected;
    await expect(session.loadAttachment(image)).rejects.toThrow("Session is closed");
  });

  it("loads the complete contact index instead of relying on exact server queries", async () => {
    const { fake, session } = await fakeSession({
      chats: [fakeChat(1)],
      contacts: [{ displayName: "Formatted Person", phoneNumbers: [{ address: "+1 (555) 000-0001" }] }],
    });
    await session.start();
    await eventually(() => session.getSnapshot().chats.values().next().value?.title === "Formatted Person");
    expect(session.getSnapshot().chats.values().next().value?.title).toBe("Formatted Person");
    expect(fake.requests.find((request) => request.path === "/api/v1/contact/query")?.body).toEqual({ addresses: [] });
    await session.close();
  });

  it("keeps a stable snapshot, hydrates every chat page, and loads history on demand", async () => {
    const chats = Array.from({ length: 205 }, (_, index) => fakeChat(index));
    const { fake, session } = await fakeSession({ chats, messages: {} });
    const initial = session.getSnapshot();
    expect(session.getSnapshot()).toBe(initial);
    let changes = 0;
    const unsubscribe = session.subscribe(() => { changes += 1; });

    await session.start();

    expect(session.getSnapshot().connection).toBe("online");
    expect(session.getSnapshot().chats.size).toBe(205);
    expect(fake.requests.filter((request) => request.path === "/api/v1/chat/query").map((request) => (request.body as { offset: number }).offset)).toEqual([0, 200]);
    for (const guid of session.getSnapshot().chats.keys()) {
      expect(session.getSnapshot().history.get(guid)).toBeUndefined();
    }
    const chatGuid = [...session.getSnapshot().chats.keys()][0]!;
    session.act({ type: "open-chat", chatGuid });
    await eventually(() => session.getSnapshot().history.get(chatGuid)?.kind === "ready");
    expect(session.getSnapshot().messages.get(chatGuid)).toEqual([]);
    const historyRequests = fake.requests.filter((request) => request.path.endsWith("/message")).length;
    session.act({ type: "load-history", chatGuid, mode: "older" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.requests.filter((request) => request.path.endsWith("/message"))).toHaveLength(historyRequests);
    expect(changes).toBeGreaterThan(0);
    unsubscribe();
    await session.close();
  });

  it("sends through the HTTP fake and reconciles its socket echo", async () => {
    const { fake, session } = await fakeSession();
    await session.start();
    const chatGuid = [...session.getSnapshot().chats.keys()][0]!;
    session.act({ type: "draft-set", chatGuid, text: "hello from test" });
    session.act({ type: "send", chatGuid });

    await eventually(() => fake.sent.length === 1 && session.getSnapshot().outbox.size === 0);

    const copies = session.getSnapshot().messages.get(chatGuid)?.filter((message) => message.kind === "text" && message.body === "hello from test");
    expect(copies).toHaveLength(1);
    await session.close();
  });

  it("marks incoming messages read locally without Private API", async () => {
    const { fake, session } = await fakeSession({ privateApi: false, helperConnected: false });
    await session.start();
    const chatGuid = [...session.getSnapshot().chats.keys()][0]!;
    session.act({ type: "open-chat", chatGuid });
    fake.emit("new-message", {
      guid: "incoming-live", chatGuid, text: "live", isFromMe: false,
      dateCreated: Date.now(), handle: { address: "+15551230001", service: "iMessage" }, chats: [{ guid: chatGuid }],
    });

    await eventually(() => session.getSnapshot().messages.get(chatGuid)?.some((message) => message.guid === "incoming-live") === true);
    expect(session.getSnapshot().readAt.has(chatGuid)).toBe(true);
    expect(fake.requests.some((request) => request.path.endsWith("/read"))).toBe(false);
    await session.close();
  });

  it("keeps failed history visible and allows a retry", async () => {
    const guid = parseChatGuid("iMessage;+;+15551239999");
    const { fake, session } = await fakeSession({
      chats: [{ guid, style: 45, displayName: "", unreadCount: 0, participants: [{ address: "+15551239999", service: "iMessage" }] }],
      messages: { [guid]: [] },
      failures: { [`GET /api/v1/chat/${encodeURIComponent(guid)}/message`]: { status: 500, message: "history broke" } },
    });
    await session.start();
    session.act({ type: "load-history", chatGuid: guid, mode: "latest" });
    await eventually(() => session.getSnapshot().history.get(guid)?.kind === "error");
    expect(session.getSnapshot().history.get(guid)?.kind).toBe("error");
    fake.failures.clear();
    session.act({ type: "load-history", chatGuid: guid, mode: "latest" });
    await eventually(() => session.getSnapshot().history.get(guid)?.kind === "ready");
    await session.close();
  });

  it("does not automatically retry an uncertain send", async () => {
    const { fake, session } = await fakeSession({ failures: { "POST /api/v1/message/text": { status: 500, message: "send failed" } } });
    await session.start();
    const chatGuid = [...session.getSnapshot().chats.keys()][0]!;
    session.act({ type: "draft-set", chatGuid, text: "maybe sent" });
    session.act({ type: "send", chatGuid });
    await eventually(() => [...session.getSnapshot().outbox.values()].some((item) => item.phase === "uncertain"));
    const tempGuid = [...session.getSnapshot().outbox.keys()][0]!;
    const sends = fake.requests.filter((request) => request.path === "/api/v1/message/text").length;
    session.act({ type: "retry-send", tempGuid });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.requests.filter((request) => request.path === "/api/v1/message/text")).toHaveLength(sends);
    expect(session.getSnapshot().input.kind).toBe("retry-confirm");
    await session.close();
  });

  it("restores drafts from an account journal", async () => {
    const fake = new FakeBb();
    servers.push(fake);
    await fake.listen(0);
    const directory = await mkdtemp(join(tmpdir(), "imsg-session-"));
    const configFile = join(directory, "config.json");
    const first = createSession({ url: fake.url, password: fake.password, journal: createJournal({ url: fake.url, password: fake.password, configFile }) });
    await first.start();
    const chatGuid = [...first.getSnapshot().chats.keys()][0]!;
    first.act({ type: "draft-set", chatGuid, text: "survives restart" });
    await first.close();

    const second = createSession({ url: fake.url, password: fake.password, journal: createJournal({ url: fake.url, password: fake.password, configFile }) });
    await second.start();
    expect(second.getSnapshot().drafts.get(chatGuid)?.text).toBe("survives restart");
    await second.close();
  });

  it("discovers and names a chat first seen on the socket", async () => {
    const { fake, session } = await fakeSession({ contacts: [{ displayName: "New Person", phoneNumbers: [{ address: "+15550009999" }] }] });
    await session.start();
    const chatGuid = parseChatGuid("iMessage;+;+15550009999");
    fake.chats.push({ guid: chatGuid, style: 45, displayName: "", unreadCount: 1, participants: [{ address: "+15550009999", service: "iMessage" }] });
    fake.emit("new-message", {
      guid: "unknown-chat-message", chatGuid, text: "hello", isFromMe: false,
      dateCreated: Date.now(), handle: { address: "+15550009999", service: "iMessage" }, chats: [{ guid: chatGuid }],
    });

    await eventually(() => session.getSnapshot().chats.get(chatGuid)?.title === "New Person");
    expect(session.getSnapshot().chats.get(chatGuid)?.provisional).toBeUndefined();
    await session.close();
  });

  it("surfaces a journal flush failure after closing its resources", async () => {
    const journal: Journal = {
      load: async () => undefined,
      save: async () => undefined,
      flush: async () => { throw new Error("disk full"); },
    };
    const session = createSession({ url: "http://127.0.0.1:1", password: "test", journal });
    await expect(session.close()).rejects.toThrow("disk full");
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("catches up every bounded page despite a newer optimistic message", async () => {
    const base = Date.now() - 20_000;
    const chat = fakeChat(900);
    const initial: FakeMessage = {
      guid: "initial", chatGuid: chat.guid, text: "initial", isFromMe: false,
      dateCreated: base, handle: { address: chat.participants[0]!.address, service: "iMessage" }, chats: [{ guid: chat.guid }],
    };
    chat.lastMessage = initial;
    const fake = new FakeBb({ chats: [chat], messages: { [chat.guid]: [initial] }, delays: { "POST /api/v1/message/text": 1_000 } });
    servers.push(fake);
    await fake.listen(0);
    const socket = controlledSocket();
    const session = createSession({ url: fake.url, password: fake.password, journal: memoryJournal(), connectSocket: socket.connectSocket });
    await session.start();
    session.act({ type: "open-chat", chatGuid: parseChatGuid(chat.guid) });
    await eventually(() => session.getSnapshot().history.get(parseChatGuid(chat.guid))?.kind === "ready");
    socket.dispatch({ type: "connection", connection: "offline" });
    const outageTime = Date.now();
    const outage = Array.from({ length: 250 }, (_, index): FakeMessage => ({
      guid: `outage-${index}`, chatGuid: chat.guid, text: `missed ${index}`, isFromMe: false,
      dateCreated: outageTime, handle: { address: chat.participants[0]!.address, service: "iMessage" }, chats: [{ guid: chat.guid }],
    }));
    fake.messages.get(chat.guid)!.push(...outage);
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.act({ type: "draft-set", chatGuid: parseChatGuid(chat.guid), text: "optimistic" });
    session.act({ type: "send", chatGuid: parseChatGuid(chat.guid) });
    socket.dispatch({ type: "connection", connection: "online" });

    await eventually(() => outage.every((item) => session.getSnapshot().messages.get(parseChatGuid(chat.guid))?.some((message) => message.guid === item.guid) === true));
    expect(fake.requests.filter((request) => request.path === "/api/v1/message/query")).toHaveLength(2);
    await session.close();
  });

  it("clears an older mark-read failure after a successful retry", async () => {
    const { fake, session } = await fakeSession({
      failures: { "POST /api/v1/chat/iMessage%3B%2B%3B%2B15551230001/read": { status: 500, message: "read failed" } },
      delays: { "POST /api/v1/chat/iMessage%3B%2B%3B%2B15551230001/read": 120 },
    });
    await session.start();
    const chatGuid = parseChatGuid("iMessage;+;+15551230001");
    session.act({ type: "open-chat", chatGuid });
    await eventually(() => fake.requests.some((request) => request.path.endsWith("/read")));
    fake.failures.clear();
    fake.delays.clear();
    session.act({ type: "retry-read", chatGuid });
    await eventually(() => fake.requests.filter((request) => request.path.endsWith("/read")).length === 2);
    await eventually(() => !session.getSnapshot().readPending.has(chatGuid), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.getSnapshot().readPending.has(chatGuid)).toBe(false);
    expect(session.getSnapshot().readAt.has(chatGuid)).toBe(true);
    await session.close();
  });

  it("quits promptly while startup HTTP is pending", async () => {
    const fake = new FakeBb({ delays: { "POST /api/v1/chat/query": 1_000 } });
    servers.push(fake);
    await fake.listen(0);
    let quitFinished = false;
    let session: ReturnType<typeof createSession>;
    session = createSession({
      url: fake.url, password: fake.password, journal: memoryJournal(),
      quit: async () => { await session.close(); quitFinished = true; },
    });
    void session.start();
    await eventually(() => fake.requests.some((request) => request.path === "/api/v1/chat/query"));
    session.act({ type: "quit" });
    await eventually(() => quitFinished, 500);
    expect(quitFinished).toBe(true);
  });
  it("creates a conversation with its first message and loads the transcript", async () => {
    const { fake, session } = await fakeSession();
    await session.start();
    session.act({ type: "input", input: { kind: "new-chat", addresses: "+15551239998", text: "First message", service: "SMS", field: "text", busy: false, error: null } });
    session.act({ type: "create-chat", addresses: "+15551239998", text: "First message", service: "SMS" });
    const guid = parseChatGuid("SMS;+;+15551239998");
    await eventually(() => session.getSnapshot().selected === guid && session.getSnapshot().history.get(guid)?.kind === "ready");
    expect(session.getSnapshot().messages.get(guid)).toHaveLength(1);
    expect(session.getSnapshot().messages.get(guid)?.[0]).toMatchObject({ body: "First message", from: { service: "SMS" } });
    expect(fake.requests.filter((request) => request.path === "/api/v1/chat/new")).toHaveLength(1);
    await session.close();
  });

  it("does not send before the pending message is durably recorded", async () => {
    const fake = new FakeBb();
    servers.push(fake);
    await fake.listen(0);
    const journal: Journal = {
      load: async () => undefined,
      save: async () => { throw new Error("disk full"); },
      flush: async () => { throw new Error("disk full"); },
    };
    const session = createSession({ url: fake.url, password: fake.password, journal });
    await session.start();
    const chatGuid = [...session.getSnapshot().chats.keys()][0]!;
    session.act({ type: "draft-set", chatGuid, text: "must be recorded first" });
    session.act({ type: "send", chatGuid });
    await eventually(() => [...session.getSnapshot().outbox.values()].some((item) => item.phase === "failed"));
    expect(fake.sent).toHaveLength(0);
    await expect(session.close()).rejects.toThrow("disk full");
  });

  it("opens URLs even when ssh is set and notices Opened.", async () => {
    const opened: HttpUrl[] = [];
    const session = createSession({
      url: "http://127.0.0.1:1",
      password: "test",
      journal: memoryJournal(),
      ssh: true,
      openUrl: async (url) => { opened.push(url); },
    });
    const url = parseHttpUrl("https://example.test/from-ssh");
    session.act({ type: "open-url", url });
    await eventually(() => opened.length === 1);
    expect(opened).toEqual([url]);
    expect(session.getSnapshot().notice).toEqual({ kind: "info", text: "Opened." });
    await session.close();
  });

  it("caches successful link previews and does not refetch on hit", async () => {
    let requests = 0;
    const url = parseHttpUrl("https://cache.test/item");
    const session = createSession({
      url: "http://127.0.0.1:1",
      password: "test",
      journal: memoryJournal(),
      resolveLinkPreview: async (target) => {
        requests += 1;
        return { kind: "page", url: target, site: "cache.test", title: "Cached" };
      },
    });
    const first = await session.loadLinkPreview(url);
    const second = await session.loadLinkPreview(url);
    expect(first).toEqual(second);
    expect(requests).toBe(1);
    await session.close();
  });

  it("coalesces in-flight link preview loads and retries after failure", async () => {
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const url = parseHttpUrl("https://coalesce.test/item");
    const session = createSession({
      url: "http://127.0.0.1:1",
      password: "test",
      journal: memoryJournal(),
      resolveLinkPreview: async (target) => {
        requests += 1;
        if (requests === 1) {
          await gate;
          throw new Error("temporary link failure");
        }
        return { kind: "host", url: target, site: "coalesce.test" };
      },
    });
    const first = session.loadLinkPreview(url);
    const second = session.loadLinkPreview(url);
    await Promise.resolve();
    expect(requests).toBe(1);
    release();
    await expect(first).rejects.toThrow(/temporary link failure/);
    await expect(second).rejects.toThrow(/temporary link failure/);
    await expect(session.loadLinkPreview(url)).resolves.toEqual({ kind: "host", url, site: "coalesce.test" });
    expect(requests).toBe(2);
    await session.close();
  });

});
