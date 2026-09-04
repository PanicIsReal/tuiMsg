import { afterEach, describe, expect, it } from "vitest";
import { FakeBb } from "../../src/bb/fake.ts";
import { BbClient, hydrate } from "../../src/bb/rest.ts";
import { parseChatGuid } from "../../src/domain/ids.ts";

let fake: FakeBb | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("BbClient against fake", () => {
  it("hydrates ping, info, and chats in parallel", async () => {
    fake = new FakeBb();
    await fake.listen(0);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = async (input: string | URL, init?: RequestInit) => {
      started.push(String(input));
      await gate;
      return fetch(input, init);
    };
    const measured = new BbClient({ url: fake.url, password: fake.password, fetch: gated });
    const pending = hydrate(measured);
    await Promise.resolve();
    expect(started.length).toBe(3);
    release();
    const result = await pending;
    expect(result.online).toBe(true);
    expect(result.info.helperConnected).toBe(true);
    expect(result.chats.length).toBeGreaterThan(0);
  });

  it("encodes chat guids in message paths", async () => {
    fake = new FakeBb();
    await fake.listen(0);
    const urls: string[] = [];
    const spy = async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      return fetch(input, init);
    };
    const client = new BbClient({ url: fake.url, password: fake.password, fetch: spy });
    const guid = parseChatGuid("iMessage;+;+15551230001");
    const messages = await client.listMessages(guid);
    expect(messages.some((m) => m.kind === "text")).toBe(true);
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
    await client.sendText({ chatGuid: guid, message: "ping", tempGuid: "temp-abc" });
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

  it("lists a group as distinct from a DM", async () => {
    fake = new FakeBb();
    await fake.listen(0);
    const client = new BbClient({ url: fake.url, password: fake.password });
    const chats = await client.listChats();
    const group = chats.find((c) => c.kind === "group");
    const dm = chats.find((c) => c.kind === "dm" && c.service === "iMessage");
    expect(group?.title).toBe("Weekend");
    expect(group?.participants.length).toBeGreaterThan(1);
    expect(dm?.kind).toBe("dm");
    expect(dm?.guid).toContain(";");
    expect(dm?.guid).toContain("+");
  });

  it("skips Private API paths when helper_connected is false", async () => {
    fake = new FakeBb({ helperConnected: false, privateApi: false });
    await fake.listen(0);
    const urls: string[] = [];
    const spy = async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      return fetch(input, init);
    };
    const client = new BbClient({ url: fake.url, password: fake.password, fetch: spy });
    await client.serverInfo();
    expect(client.helperConnected).toBe(false);
    const guid = parseChatGuid("iMessage;+;+15551230001");
    await client.markRead(guid);
    await client.startTyping(guid);
    await client.sendReaction({ chatGuid: guid, messageGuid: "m1", reaction: "love" });
    await client.sendText({
      chatGuid: guid,
      message: "fallback",
      tempGuid: "temp-no-papi",
      method: "private-api",
    });
    expect(urls.some((u) => u.includes("/read"))).toBe(false);
    expect(urls.some((u) => u.includes("/typing"))).toBe(false);
    expect(urls.some((u) => u.includes("/react"))).toBe(false);
    expect(fake.sent[0]?.text).toBe("fallback");
  });
});
