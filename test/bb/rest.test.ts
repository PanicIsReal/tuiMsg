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
    const client = new BbClient({ url: fake.url, password: fake.password });
    const guid = parseChatGuid("iMessage;+;+15551230001");
    const messages = await client.listMessages(guid);
    expect(messages.some((m) => m.kind === "text")).toBe(true);
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
});
