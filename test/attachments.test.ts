import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveAttachment } from "../src/attachments.ts";

describe("attachments", () => {
  it("uses safe exclusive filenames without traversal or clobbering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imsg-attachment-"));
    const attachment = { guid: "a", name: "../../private/notes.txt", mime: "text/plain", bytes: 3 };
    const first = await saveAttachment({ attachment, bytes: new Uint8Array([1, 2, 3]), directory });
    const second = await saveAttachment({ attachment, bytes: new Uint8Array([4]), directory });

    expect(first).toBe(join(directory, "notes.txt"));
    expect(second).toBe(join(directory, "notes-1.txt"));
    expect([...await readFile(first)]).toEqual([1, 2, 3]);
    expect([...await readFile(second)]).toEqual([4]);
  });
});
