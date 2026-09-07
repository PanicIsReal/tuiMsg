import { afterEach, describe, expect, it } from "vitest";
import { FakeBb } from "../../src/bb/fake.ts";
import { BbClient, BbError, MAX_DOWNLOAD_BYTES, MAX_PREVIEW_BYTES } from "../../src/bb/rest.ts";
import { parseChatGuid, parseMessageGuid } from "../../src/domain/ids.ts";

let fake: FakeBb | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("BbClient against fake", () => {
  it("encodes chat guids in message paths", async () => {
    fake = new FakeBb();
    await fake.listen(0);
    const urls: string[] = [];
    const spy = async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      return fetch(input, init);
    };
    const client = new BbClient({
      url: fake.url,
      password: fake.password,
      fetch: spy,
    });
    const guid = parseChatGuid("iMessage;+;+15551230001");
    const page = await client.listMessages(guid);
    expect(page.messages.some((m) => m.kind === "text")).toBe(true);
    const path = urls[0] ?? "";
    expect(path).toContain(encodeURIComponent("iMessage;+;+15551230001"));
    expect(path).toContain("%3B");
    expect(path).toContain("%2B");
  });

  it("sends text with tempGuid and records it", async () => {
    fake = new FakeBb();
    await fake.listen(0);
    const client = new BbClient({ url: fake.url, password: fake.password });
    const guid = parseChatGuid("iMessage;+;+15551230001");
    await client.sendText({
      chatGuid: guid,
      message: "ping",
      tempGuid: "temp-abc",
    });
    expect(fake.sent[0]?.text).toBe("ping");
    expect(fake.sent[0]?.tempGuid).toBe("temp-abc");
  });

  it("resolves contacts", async () => {
    fake = new FakeBb();
    await fake.listen(0);
    const client = new BbClient({ url: fake.url, password: fake.password });
    const contacts = await client.queryContacts(["+15551230001"]);
    expect(contacts[0]?.displayName).toBe("Jane Doe");
  });

  it("uses the server's empty-address mode to list every contact", async () => {
    fake = new FakeBb();
    await fake.listen(0);
    const client = new BbClient({ url: fake.url, password: fake.password });
    const contacts = await client.queryContacts([]);
    expect(contacts.length).toBeGreaterThan(1);
    expect(fake.requests.at(-1)?.body).toEqual({ addresses: [] });
  });

  it("lists a group as distinct from a DM", async () => {
    fake = new FakeBb();
    await fake.listen(0);
    const client = new BbClient({ url: fake.url, password: fake.password });
    const page = await client.listChats();
    const group = page.chats.find((c) => c.kind === "group");
    const dm = page.chats.find(
      (c) => c.kind === "dm" && c.service === "iMessage",
    );
    expect(group?.title).toBe("Weekend");
    expect(group?.participants.length).toBeGreaterThan(1);
    expect(dm?.kind).toBe("dm");
    expect(dm?.guid).toContain(";");
    expect(dm?.guid).toContain("+");
  });

  it("falls back for text and rejects unavailable Private API operations", async () => {
    fake = new FakeBb({ helperConnected: false, privateApi: false });
    await fake.listen(0);
    const urls: string[] = [];
    const spy = async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      return fetch(input, init);
    };
    const client = new BbClient({
      url: fake.url,
      password: fake.password,
      fetch: spy,
    });
    await client.serverInfo();
    expect(client.helperConnected).toBe(false);
    const guid = parseChatGuid("iMessage;+;+15551230001");
    await expect(client.markRead(guid)).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(client.startTyping(guid)).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(
      client.sendReaction({
        chatGuid: guid,
        messageGuid: parseMessageGuid("m1"),
        reaction: "love",
        remove: false,
      }),
    ).rejects.toMatchObject({ kind: "unsupported" });
    await client.sendText({
      chatGuid: guid,
      message: "fallback",
      tempGuid: "temp-no-papi",
    });
    expect(urls.some((u) => u.includes("/read"))).toBe(false);
    expect(urls.some((u) => u.includes("/typing"))).toBe(false);
    expect(urls.some((u) => u.includes("/react"))).toBe(false);
    expect(fake.sent[0]?.text).toBe("fallback");
  });

  it("paginates newest history, catchup, and downloads binary attachments", async () => {
    const guid = "iMessage;+;+1";
    fake = new FakeBb({
      chats: [
        {
          guid,
          style: 45,
          displayName: "",
          unreadCount: 0,
          participants: [{ address: "+1", service: "iMessage" }],
        },
      ],
      messages: {
        [guid]: [1, 2, 2, 3].map((dateCreated, i) => ({
          guid: `m${i}`,
          chatGuid: guid,
          text: `${i}`,
          isFromMe: false,
          dateCreated,
          chats: [{ guid }],
        })),
      },
      attachments: { bin: new Uint8Array([0, 255, 7]) },
    });
    await fake.listen(0);
    const client = new BbClient({ url: fake.url, password: fake.password });
    const chatGuid = parseChatGuid(guid);
    const newest = await client.listMessages(chatGuid, { limit: 2 });
    expect(newest.messages.map((m) => m.guid)).toEqual(["m2", "m3"]);
    expect(newest.next).toEqual({ before: 2, offset: 1 });
    const older = await client.listMessages(chatGuid, {
      limit: 2,
      cursor: newest.next!,
    });
    expect(older.messages.map((m) => m.guid)).toEqual(["m0", "m1"]);
    const catchup = await client.messagesSince({
      after: 2,
      before: 3,
      limit: 2,
    });
    expect(catchup.messages).toHaveLength(2);
    expect(catchup.nextOffset).toBe(2);
    expect(
      await client.downloadAttachment({
        guid: "bin",
        name: "x",
        mime: "application/octet-stream",
        bytes: 3,
      }),
    ).toEqual(new Uint8Array([0, 255, 7]));
  });

  it("requests a bounded attachment preview instead of the original", async () => {
    let requested: URL | undefined;
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async (input) => {
        requested = new URL(String(input));
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    const bytes = await client.previewAttachment({
      guid: "photo/one",
      name: "photo.jpg",
      mime: "image/jpeg",
      bytes: 100,
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(requested?.pathname).toBe("/api/v1/attachment/photo%2Fone/download");
    expect(Object.fromEntries(requested?.searchParams ?? [])).toEqual({
      original: "false",
      width: "960",
      quality: "good",
      force: "false",
      password: "pw",
    });
  });

  it("classifies and redacts failures", async () => {
    const client = new BbClient({
      url: "http://example.invalid",
      password: "secret",
      fetch: async () =>
        new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
        }),
    });
    await expect(client.ping()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BbError &&
        error.kind === "auth" &&
        !error.message.includes("secret"),
    );
  });

  it("rejects malformed envelopes and metadata", async () => {
    const primitive = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async () => new Response("null", { status: 200 }),
    });
    await expect(primitive.ping()).rejects.toMatchObject({ kind: "invalid" });
    const metadata = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async () =>
        new Response(
          JSON.stringify({ status: 200, data: [], metadata: { count: "two" } }),
          { status: 200 },
        ),
    });
    await expect(metadata.listChats()).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("redacts credentials supplied by server errors", async () => {
    const client = new BbClient({
      url: "http://example.invalid",
      password: "top-secret",
      fetch: async () =>
        new Response(
          JSON.stringify({ message: "bad password=top-secret and top-secret" }),
          { status: 401 },
        ),
    });
    await expect(client.ping()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BbError &&
        !error.message.includes("top-secret") &&
        error.message.includes("REDACTED"),
    );
  });

  it("redacts a percent-encoded password in network errors", async () => {
    const password = "top secret+";
    const client = new BbClient({
      url: "http://example.invalid",
      password,
      fetch: async () => {
        throw new Error(`fetch failed: http://example.invalid/api/v1/ping?password=${encodeURIComponent(password)}`);
      },
    });
    await expect(client.ping()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BbError &&
        !error.message.includes(password) &&
        !error.message.includes(encodeURIComponent(password)),
    );
  });

  it("does not follow redirects that would carry the password", async () => {
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify({ status: 200, data: { private_api: false, helper_connected: false } }), { status: 200 });
      },
    });
    await expect(client.ping()).resolves.toBe(true);
  });

  it("rejects an original download when Content-Length exceeds the cap", async () => {
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async () => new Response(new Uint8Array([1]), { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } }),
    });
    await expect(client.downloadAttachment({ guid: "huge", name: "clip.mov", mime: "video/quicktime", bytes: MAX_DOWNLOAD_BYTES + 1 }))
      .rejects.toSatisfy((error: unknown) => error instanceof BbError && error.kind === "invalid" && error.message.includes("256 MB"));
  });

  it("stops reading a preview body that exceeds the preview cap", async () => {
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async () => new Response(new Uint8Array(MAX_PREVIEW_BYTES + 1)),
    });
    await expect(client.previewAttachment({ guid: "photo", name: "photo.jpg", mime: "image/jpeg", bytes: MAX_PREVIEW_BYTES + 1 }))
      .rejects.toSatisfy((error: unknown) => error instanceof BbError && error.kind === "invalid" && error.message.includes("16 MB"));
  });

  it("times out while consuming JSON and binary response bodies", async () => {
    const hanging = () => new Promise<never>(() => undefined);
    const jsonClient = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      timeoutMs: 5,
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: hanging,
        }) as unknown as Response,
    });
    await expect(jsonClient.ping()).rejects.toMatchObject({
      kind: "network",
      ambiguous: false,
    });
    const binaryClient = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      timeoutMs: 5,
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: hanging,
        }) as unknown as Response,
    });
    await expect(
      binaryClient.downloadAttachment({
        guid: "a",
        name: "a",
        mime: "x",
        bytes: 1,
      }),
    ).rejects.toMatchObject({ kind: "network", ambiguous: false });
  });

  it("close aborts hanging fetch and body work and rejects later requests", async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchClient = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      timeoutMs: 60_000,
      fetch: async (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      },
    });
    const hangingFetch = fetchClient.ping();
    await Promise.resolve();
    await fetchClient.close();
    await expect(hangingFetch).rejects.toMatchObject({
      kind: "network",
      ambiguous: false,
    });
    expect(fetchSignal?.aborted).toBe(true);
    await expect(fetchClient.ping()).rejects.toThrow(/closed/);

    let bodySignal: AbortSignal | undefined;
    const bodyClient = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      timeoutMs: 60_000,
      fetch: async (_input, init) => {
        bodySignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: () => new Promise<string>(() => undefined),
        } as Response;
      },
    });
    const hangingBody = bodyClient.ping();
    await Promise.resolve();
    await bodyClient.close();
    await expect(hangingBody).rejects.toMatchObject({ kind: "network" });
    expect(bodySignal?.aborted).toBe(true);
  });
  it("keeps malformed send results uncertain and uses HTTP failure status", async () => {
    const client = new BbClient({ url: "http://example.invalid", password: "pw",
      fetch: async () => new Response("null", { status: 200 }),
    });
    await expect(client.sendText({ chatGuid: parseChatGuid("iMessage;+;+1"), message: "hi", tempGuid: "t" }))
      .rejects.toMatchObject({ kind: "invalid", ambiguous: true });
    const auth = new BbClient({ url: "http://example.invalid", password: "pw",
      fetch: async () => new Response(JSON.stringify({ status: 200 }), { status: 401 }),
    });
    await expect(auth.ping()).rejects.toMatchObject({ kind: "auth" });
    const unavailable = new BbClient({ url: "http://example.invalid", password: "pw",
      fetch: async () => new Response(JSON.stringify({ message: "authentication helper unavailable" }), { status: 500 }),
    });
    await expect(unavailable.ping()).rejects.toMatchObject({ kind: "server" });
  });

  it("keeps malformed new-conversation results uncertain", async () => {
    const client = new BbClient({ url: "http://example.invalid", password: "pw",
      fetch: async () => new Response(JSON.stringify({ status: 200, data: {} })),
    });
    await expect(client.createChat({ addresses: ["+15551239998"], message: "First", service: "SMS", tempGuid: "new-temp" }))
      .rejects.toMatchObject({ kind: "invalid", ambiguous: true });
  });

  it("rejects pagination that cannot advance", async () => {
    const client = new BbClient({ url: "http://example.invalid", password: "pw",
      fetch: async () => new Response(JSON.stringify({ status: 200, data: [], metadata: { count: 0, total: 10 } })),
    });
    await expect(client.listChats()).rejects.toThrow(/no progress/);
    await expect(client.messagesSince({ after: 0, before: 100 })).rejects.toThrow(/no progress/);
  });

});
