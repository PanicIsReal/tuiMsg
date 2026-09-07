import { describe, expect, it } from "vitest";
import { BbClient } from "../../src/bb/rest.ts";
import type { Attachment } from "../../src/domain/model.ts";
import type { Journal } from "../../src/journal.ts";
import { createSession } from "../../src/session.ts";

const journal: Journal = {
  load: async () => undefined,
  save: async () => undefined,
  flush: async () => undefined,
};

function attachment(guid: string): Attachment {
  return { guid, name: `${guid}.png`, mime: "image/png", bytes: 3 };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

describe("image preview scheduling", () => {
  it("runs two unique requests, keeps only the latest queued request, and preserves GUID deduplication", async () => {
    const gates = [deferredResponse(), deferredResponse(), deferredResponse()];
    let started = 0;
    let active = 0;
    let peakActive = 0;
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      fetch: async () => {
        const gate = gates[started++];
        if (!gate) throw new Error("unexpected preview request");
        active += 1;
        peakActive = Math.max(peakActive, active);
        return gate.promise.finally(() => { active -= 1; });
      },
    });
    const session = createSession({ url: client.url, password: "pw", client, journal });

    const first = session.loadAttachment(attachment("first"));
    const second = session.loadAttachment(attachment("second"));
    const superseded = session.loadAttachment(attachment("third"));
    const latest = session.loadAttachment(attachment("latest"));
    const duplicateLatest = session.loadAttachment(attachment("latest"));
    const supersededResult = expect(superseded).rejects.toThrow("superseded");
    await Promise.resolve();

    expect(started).toBe(2);
    expect(peakActive).toBe(2);
    await supersededResult;

    gates[0]!.resolve(new Response(new Uint8Array([1])));
    await first;
    await Promise.resolve();
    expect(started).toBe(3);
    expect(peakActive).toBe(2);

    gates[1]!.resolve(new Response(new Uint8Array([2])));
    gates[2]!.resolve(new Response(new Uint8Array([3])));
    await expect(second).resolves.toEqual(new Uint8Array([2]));
    const [latestBytes, duplicateBytes] = await Promise.all([latest, duplicateLatest]);
    expect(duplicateBytes).toBe(latestBytes);
    await session.close();
  });

  it("rejects queued work and aborts active requests when the session closes", async () => {
    const client = new BbClient({
      url: "http://example.invalid",
      password: "pw",
      timeoutMs: 60_000,
      fetch: async () => new Promise<Response>(() => undefined),
    });
    const session = createSession({ url: client.url, password: "pw", client, journal });
    const first = session.loadAttachment(attachment("first"));
    const second = session.loadAttachment(attachment("second"));
    const queued = session.loadAttachment(attachment("queued"));
    const results = Promise.allSettled([first, second, queued]);

    await Promise.resolve();
    await session.close();
    const settled = await results;
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    expect(settled.map((result) => result.status === "rejected" ? result.reason.message : "")).toEqual([
      expect.stringMatching(/closed/),
      expect.stringMatching(/closed/),
      "Session is closed",
    ]);
  });
});
