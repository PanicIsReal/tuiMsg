import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { configPath } from "./config.ts";
import type { Attachment } from "./domain/model.ts";

function safeName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").at(-1) ?? "attachment";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "attachment";
}

export async function saveAttachment(args: {
  attachment: Attachment;
  bytes: Uint8Array;
  directory?: string;
}): Promise<string> {
  const directory = args.directory ?? join(dirname(configPath()), "attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const original = safeName(args.attachment.name);
  const extension = extname(original);
  const stem = original.slice(0, original.length - extension.length) || "attachment";
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const filename = suffix === 0 ? original : `${stem}-${suffix}${extension}`;
    const path = join(directory, filename);
    try {
      await writeFile(path, args.bytes, { flag: "wx", mode: 0o600 });
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
