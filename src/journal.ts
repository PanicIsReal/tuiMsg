import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath } from "./config.ts";
import { parseChatGuid, parseMessageGuid } from "./domain/ids.ts";
import type { Draft, Outgoing, SavedSession } from "./domain/model.ts";

export type Journal = {
  load: () => Promise<SavedSession | undefined>;
  save: (saved: SavedSession) => Promise<void>;
  flush: () => Promise<void>;
};

function accountKey(url: string, password: string): string {
  return createHash("sha256").update(url).update("\0").update(password).digest("hex");
}

export function journalPath(url: string, password: string, path = configPath()): string {
  return join(dirname(path), "sessions", `${accountKey(url, password)}.json`);
}

function parseSaved(value: unknown): SavedSession {
  if (!isRecord(value) || !Array.isArray(value.drafts) || !Array.isArray(value.outbox) || !Array.isArray(value.readAt)) {
    throw new Error("saved session must contain drafts, outbox, and readAt arrays");
  }
  return { drafts: value.drafts.map(parseDraftEntry), outbox: value.outbox.map(parseOutgoing), readAt: value.readAt.map(parseReadEntry) };
}

function parseDraftEntry(value: unknown): SavedSession["drafts"][number] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !isRecord(value[1]) || typeof value[1].text !== "string" || !(value[1].replyTo === null || typeof value[1].replyTo === "string")) {
    throw new Error("saved draft is invalid");
  }
  const draft: Draft = { text: value[1].text, replyTo: value[1].replyTo === null ? null : parseMessageGuid(value[1].replyTo) };
  return [parseChatGuid(value[0]), draft];
}

function parseOutgoing(value: unknown): Outgoing {
  if (!isRecord(value) || typeof value.tempGuid !== "string" || typeof value.chatGuid !== "string" || typeof value.text !== "string" || !(value.replyTo === null || typeof value.replyTo === "string") || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || (value.phase !== "sending" && value.phase !== "failed" && value.phase !== "uncertain") || !(value.error === null || typeof value.error === "string")) {
    throw new Error("saved outgoing message is invalid");
  }
  return {
    tempGuid: parseMessageGuid(value.tempGuid), chatGuid: parseChatGuid(value.chatGuid), text: value.text,
    replyTo: value.replyTo === null ? null : parseMessageGuid(value.replyTo), createdAt: value.createdAt,
    phase: value.phase, error: value.error,
  };
}

function parseReadEntry(value: unknown): SavedSession["readAt"][number] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "number" || !Number.isFinite(value[1])) {
    throw new Error("saved read watermark is invalid");
  }
  return [parseChatGuid(value[0]), value[1]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createJournal(args: {
  url: string;
  password: string;
  configFile?: string;
}): Journal {
  const path = journalPath(args.url, args.password, args.configFile);
  let writes = Promise.resolve();
  let loadFailed = false;

  async function load(): Promise<SavedSession | undefined> {
    try {
      return parseSaved(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      loadFailed = true;
      throw new Error(`Cannot read saved session at ${path}.`);
    }
  }

  function save(saved: SavedSession): Promise<void> {
    if (loadFailed) return Promise.reject(new Error(`Cannot overwrite unreadable saved session at ${path}.`));
    const snapshot = JSON.stringify(saved);
    writes = writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${snapshot}\n`, { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        await chmod(path, 0o600);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    return writes;
  }

  return { load, save, flush: () => writes };
}
