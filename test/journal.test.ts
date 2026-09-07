import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChatGuid } from "../src/domain/ids.ts";
import { createJournal, journalPath } from "../src/journal.ts";

describe("journal", () => {
  it("separates accounts, hides credentials, and writes mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imsg-journal-"));
    const configFile = join(directory, "config.json");
    const password = "journal-secret";
    const journal = createJournal({ url: "http://127.0.0.1:1234", password, configFile });
    const chat = parseChatGuid("iMessage;+;+15551230001");
    await journal.save({ drafts: [[chat, { text: "saved draft", replyTo: null }]], outbox: [], readAt: [] });
    await journal.flush();

    const path = journalPath("http://127.0.0.1:1234", password, configFile);
    expect(path).not.toContain(password);
    expect(await readFile(path, "utf8")).not.toContain(password);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await journal.load())?.drafts[0]?.[1].text).toBe("saved draft");
    expect(journalPath("http://127.0.0.1:1234", "other", configFile)).not.toBe(path);
  });

  it("rejects malformed persisted entries at the journal boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imsg-journal-bad-"));
    const configFile = join(directory, "config.json");
    const path = journalPath("http://127.0.0.1:1234", "secret", configFile);
    await mkdir(join(directory, "sessions"), { recursive: true });
    const malformed = JSON.stringify({ drafts: [null], outbox: [], readAt: [] });
    await writeFile(path, malformed);
    const journal = createJournal({ url: "http://127.0.0.1:1234", password: "secret", configFile });
    await expect(journal.load()).rejects.toThrow("Cannot read saved session");
    await expect(journal.save({ drafts: [], outbox: [], readAt: [] })).rejects.toThrow("Cannot overwrite unreadable saved session");
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it("rejects an outgoing phase that only stringifies to a valid value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imsg-journal-phase-"));
    const configFile = join(directory, "config.json");
    const path = journalPath("http://127.0.0.1:1234", "secret", configFile);
    await mkdir(join(directory, "sessions"), { recursive: true });
    await writeFile(path, JSON.stringify({
      drafts: [],
      outbox: [{ tempGuid: "temp", chatGuid: "iMessage;+;+15551230001", text: "hello", replyTo: null, createdAt: 1, phase: ["sending"], error: null }],
      readAt: [],
    }));
    const journal = createJournal({ url: "http://127.0.0.1:1234", password: "secret", configFile });
    await expect(journal.load()).rejects.toThrow("Cannot read saved session");
  });
});
