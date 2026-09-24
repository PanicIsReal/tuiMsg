import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import { dataDirectory } from "./config.ts";
import type { Attachment } from "./domain/model.ts";

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

function safeName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").at(-1) ?? "attachment";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "attachment";
}

// imsg reports where Messages stored each file; files offloaded to iCloud are marked missing.
export function attachmentPath(attachment: Attachment): string {
  if (!attachment.path || attachment.missing) {
    throw new Error(`${attachment.name} is not downloaded on this Mac. Open it once in Messages, then try again.`);
  }
  return attachment.path;
}

export async function readAttachment(attachment: Attachment): Promise<Uint8Array> {
  const path = attachmentPath(attachment);
  if ((await stat(path)).size > MAX_PREVIEW_BYTES) throw new Error("Image is too large to preview. Use o to open the original.");
  return new Uint8Array(await readFile(path));
}

export async function saveAttachment(args: {
  attachment: Attachment;
  directory?: string;
}): Promise<string> {
  const source = attachmentPath(args.attachment);
  const directory = args.directory ?? join(dataDirectory(), "attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const original = safeName(args.attachment.name);
  const extension = extname(original);
  const stem = original.slice(0, original.length - extension.length) || "attachment";
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const filename = suffix === 0 ? original : `${stem}-${suffix}${extension}`;
    const path = join(directory, filename);
    try {
      await copyFile(source, path, constants.COPYFILE_EXCL);
      return path;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not choose a free attachment filename.");
}

export async function openLocalFile(path: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Opening attachments is supported on macOS only.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", [path], { stdio: "ignore", detached: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`open exited with status ${code ?? "unknown"}`)));
  });
}

export function isImageAttachment(attachment: Attachment): boolean {
  return attachment.mime.toLowerCase().startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(attachment.name);
}
