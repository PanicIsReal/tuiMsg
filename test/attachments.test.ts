import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentPath, saveAttachment } from "../src/attachments.ts";

describe("attachments", () => {
  it("copies with safe exclusive filenames without traversal or clobbering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuimsg-attachment-"));
    const first = join(directory, "first.bin");
    const second = join(directory, "second.bin");
    await writeFile(first, new Uint8Array([1, 2, 3]));
    await writeFile(second, new Uint8Array([4]));
    const target = join(directory, "saved");
    const name = "../../private/notes.txt";
    const one = await saveAttachment({ attachment: { guid: "a", name, mime: "text/plain", bytes: 3, path: first }, directory: target });
    const two = await saveAttachment({ attachment: { guid: "b", name, mime: "text/plain", bytes: 1, path: second }, directory: target });

    expect(one).toBe(join(target, "notes.txt"));
    expect(two).toBe(join(target, "notes-1.txt"));
    expect([...await readFile(one)]).toEqual([1, 2, 3]);
    expect([...await readFile(two)]).toEqual([4]);
  });

  it("explains attachments that Messages has not downloaded", () => {
    expect(() => attachmentPath({ guid: "c", name: "IMG_1.HEIC", mime: "image/heic", bytes: 1, path: "/tmp/x", missing: true })).toThrow(/not downloaded on this Mac/);
    expect(() => attachmentPath({ guid: "d", name: "clip.mov", mime: "video/quicktime", bytes: 1 })).toThrow(/not downloaded/);
  });
});
