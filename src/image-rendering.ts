import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_FRAMES = 60;
const run = promisify(execFile);
export type ImageFrame = { ansi: string; png: Buffer; delay: number };
export type DecodedImage = { frames: ImageFrame[]; width: number; height: number; still: boolean };
export type ImageArea = { x: number; y: number; width: number; height: number };

export function supportsNativeImages(env: NodeJS.ProcessEnv = process.env, tty = Boolean(process.stdout.isTTY)): boolean {
  return tty && !env.TMUX && (Boolean(env.KITTY_WINDOW_ID) || env.TERM === "xterm-kitty" || env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "ghostty");
}

export function imageCellSize(width: number, height: number, columns: number, rows: number) {
  const scale = Math.min(Math.max(1, columns) / width, Math.max(1, rows) * 2 / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.ceil(height * scale / 2)) };
}

export async function decodeImage(bytes: Uint8Array, columns: number, rows: number, signal?: AbortSignal): Promise<DecodedImage> {
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Image exceeds the 32 MB preview limit.");
  let source: Buffer = Buffer.from(bytes);
  const options = { limitInputPixels: MAX_PIXELS, failOn: "error" as const };
  let metadata;
  try {
    metadata = await sharp(source, options).metadata();
    await sharp(source, options).resize(1, 1).raw().toBuffer();
  } catch (error) {
    const heif = source.subarray(4, 8).toString() === "ftyp" && /heic|heix|hevc|hevx|mif1/.test(source.subarray(8, 40).toString());
    if (!heif || process.platform !== "darwin") throw error;
    source = await convertHeic(source, signal);
    metadata = await sharp(source, options).metadata();
  }
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.pageHeight ?? metadata.height;
  if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_PIXELS) throw new Error("Image dimensions exceed the preview limit.");
  const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
  const size = imageCellSize(rotated ? sourceHeight : sourceWidth, rotated ? sourceWidth : sourceHeight, columns, rows);
  const pages = metadata.pages ?? 1;
  const frameCount = pages <= MAX_FRAMES && pages * sourceWidth * sourceHeight <= MAX_PIXELS ? pages : 1;
  const frames: ImageFrame[] = [];
  for (let page = 0; page < frameCount; page++) {
    signal?.throwIfAborted();
    const pipeline = sharp(source, { ...options, page, pages: 1 }).autoOrient();
    const png = await pipeline.clone().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const { data, info } = await pipeline.resize(size.width, size.height * 2, { fit: "fill" })
      .flatten({ background: "#181B21" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    frames.push({ ansi: halfBlocks(data, info.width, info.height, info.channels), png, delay: Math.max(80, metadata.delay?.[page] ?? 100) });
  }
  return { frames, ...size, still: pages > frameCount };
}

function halfBlocks(data: Buffer, width: number, height: number, channels: number): string {
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = (y * width + x) * channels;
      const bottom = (Math.min(y + 1, height - 1) * width + x) * channels;
      line += `\x1b[48;2;${data[top]};${data[top + 1]};${data[top + 2]}m\x1b[38;2;${data[bottom]};${data[bottom + 1]};${data[bottom + 2]}m▄`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

async function convertHeic(source: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "imsg-preview-"));
  try {
    const input = join(directory, "source.heic");
    const output = join(directory, "preview.png");
    await writeFile(input, source, { mode: 0o600 });
    await run("/usr/bin/sips", ["-s", "format", "png", "--resampleHeightWidthMax", "4096", input, "--out", output], { timeout: 15_000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) });
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function kittyImage(png: Buffer, id: number, area: ImageArea): string {
  const encoded = png.toString("base64");
  let output = `\x1b7\x1b[${area.y + 1};${area.x + 1}H`;
  for (let offset = 0; offset < encoded.length; offset += 4096) {
    const more = offset + 4096 < encoded.length ? 1 : 0;
    const control = offset === 0 ? `a=T,f=100,q=2,i=${id},c=${area.width},r=${area.height},C=1` : "q=2";
    output += `\x1b_G${control},m=${more};${encoded.slice(offset, offset + 4096)}\x1b\\`;
  }
  return `${output}\x1b8`;
}

export function deleteKittyImage(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

type NativeImage = { png: Buffer; measure: () => ImageArea | null };
type RegisteredImage = NativeImage & { transmitted: boolean; placed: boolean };
const images = new Map<number, RegisteredImage>();
let nextImageId = 17000;
export function registerImage(image: NativeImage): () => void {
  const id = ++nextImageId;
  images.set(id, { ...image, transmitted: false, placed: false });
  repaintImages();
  return () => {
    images.delete(id);
    if (process.stdout.isTTY) process.stdout.write(deleteKittyImage(id));
  };
}

const visibilityObservers = new Set<() => void>();
export function observeImageVisibility(observe: () => void): () => void {
  visibilityObservers.add(observe);
  repaintImages();
  return () => { visibilityObservers.delete(observe); };
}
let pendingPaint: ReturnType<typeof setImmediate> | undefined;
export function repaintImages(): void {
  if (pendingPaint) return;
  pendingPaint = setImmediate(() => {
    pendingPaint = undefined;
    for (const observe of visibilityObservers) observe();
    if (supportsNativeImages()) paintImages();
  });
}

function paintImages(): void {
  for (const [id, image] of images) {
    const area = image.measure();
    const removePlacement = `\x1b_Ga=d,d=i,i=${id},q=2\x1b\\`;
    if (!area || area.width < 1 || area.height < 1 || area.x < 0 || area.y < 0 || area.x + area.width > process.stdout.columns || area.y + area.height > process.stdout.rows) {
      if (image.placed) {
        process.stdout.write(removePlacement);
        image.placed = false;
      }
      continue;
    }
    if (!image.transmitted) {
      process.stdout.write(kittyImage(image.png, id, area));
      image.transmitted = true;
    } else {
      process.stdout.write(`${image.placed ? removePlacement : ""}\x1b7\x1b[${area.y + 1};${area.x + 1}H\x1b_Ga=p,i=${id},q=2,c=${area.width},r=${area.height},C=1;\x1b\\\x1b8`);
    }
    image.placed = true;
  }
}

export function cleanupImages(): void {
  if (pendingPaint) clearImmediate(pendingPaint);
  pendingPaint = undefined;
  if (process.stdout.isTTY) for (const id of images.keys()) process.stdout.write(deleteKittyImage(id));
  images.clear();
}
