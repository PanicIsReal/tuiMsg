import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChatGuid } from "../src/domain/ids.ts";
import { createJournal, journalPath } from "../src/journal.ts";

describe("journal", () => {
  it("writes drafts privately with mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuimsg-journal-"));
    const path = journalPath(directory);
    const journal = createJournal(path);
    const chat = parseChatGuid("iMessage;-;+15551230001");
    await journal.save({ drafts: [[chat, { text: "saved draft", replyTo: null }]], outbox: [], readAt: [] });
    await journal.flush();

    expect(path).toBe(join(directory, "session.json"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await journal.load())?.drafts[0]?.[1].text).toBe("saved draft");
  });

  it("rejects malformed persisted entries at the journal boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuimsg-journal-bad-"));
    const path = journalPath(directory);
    const malformed = JSON.stringify({ drafts: [null], outbox: [], readAt: [] });
    await writeFile(path, malformed);
    const journal = createJournal(path);
    await expect(journal.load()).rejects.toThrow("Cannot read saved session");
    await expect(journal.save({ drafts: [], outbox: [], readAt: [] })).rejects.toThrow("Cannot overwrite unreadable saved session");
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it("rejects an outgoing phase that only stringifies to a valid value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuimsg-journal-phase-"));
    const path = journalPath(directory);
    await writeFile(path, JSON.stringify({
      drafts: [],
      outbox: [{ tempGuid: "temp", chatGuid: "iMessage;+;+15551230001", text: "hello", replyTo: null, createdAt: 1, phase: ["sending"], error: null }],
      readAt: [],
    }));
    const journal = createJournal(path);
    await expect(journal.load()).rejects.toThrow("Cannot read saved session");
  });
});
