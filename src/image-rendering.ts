import sharp, { type Sharp } from "sharp";
import { execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenTracker } from "./screen-tracker.ts";
import { FrameDiff, frameText, noDamage, type Damage } from "./frame-diff.ts";
import { decodeIndexedPng, encodeSixel, type IndexedImage } from "./sixel.ts";
import { benchmark } from "./benchmark.ts";
import { kittyFromEnvironment, type CellSize, type Graphics } from "./terminal-graphics.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_FRAMES = 60;
const MAX_SIXEL_PIXELS = 6_000_000;
const BACKGROUND = "#121212";
// A half-block cell shows two square pixels stacked, so it is twice as tall as wide.
const HALF_BLOCK_CELL: CellSize = { width: 1, height: 2 };
const run = promisify(execFile);
// `png` is only made for kitty. `sixel` holds one strip per cell row, so a rewritten row is
// redrawn without the rest.
export type ImageFrame = { ansi: string; png?: Buffer; delay: number; sixel?: string[] };
export type DecodedImage = { frames: ImageFrame[]; width: number; height: number; still: boolean };
export type ImageArea = { x: number; y: number; width: number; height: number };

export function supportsNativeImages(env: NodeJS.ProcessEnv = process.env, tty = Boolean(process.stdout.isTTY)): boolean {
  return tty && kittyFromEnvironment(env);
}

let configured: Graphics | undefined;
// Set once at startup from the terminal probe; until then only the environment decides.
export function configureGraphics(graphics: Graphics | undefined): void {
  configured = graphics;
}

export function activeGraphics(): Graphics {
  return configured ?? { protocol: supportsNativeImages() ? "kitty" : "blocks", cell: { width: 10, height: 20 } };
}

export function imageCellSize(width: number, height: number, columns: number, rows: number, cell: CellSize = HALF_BLOCK_CELL) {
  const scale = Math.min(Math.max(1, columns) * cell.width / width, Math.max(1, rows) * cell.height / height);
  return {
    width: Math.min(Math.max(1, columns), Math.max(1, Math.round(width * scale / cell.width))),
    height: Math.min(Math.max(1, rows), Math.max(1, Math.round(height * scale / cell.height))),
  };
}

// `background` fills transparent pixels (stickers, PNGs); pass the canvas color behind them.
export async function decodeImage(bytes: Uint8Array, columns: number, rows: number, signal?: AbortSignal, background = BACKGROUND): Promise<DecodedImage> {
  const began = performance.now();
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
    source = await convertHeic(source, previewBound(activeGraphics(), columns, rows), signal);
    metadata = await sharp(source, options).metadata();
  }
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.pageHeight ?? metadata.height;
  if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_PIXELS) throw new Error("Image dimensions exceed the preview limit.");
  const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
  const graphics = activeGraphics();
  const sixel = graphics.protocol === "sixel";
  // Sized in the terminal's own cell shape, so the sixel and its placeholder line up.
  const size = imageCellSize(rotated ? sourceHeight : sourceWidth, rotated ? sourceWidth : sourceHeight, columns, rows, sixel ? graphics.cell : HALF_BLOCK_CELL);
  const pages = metadata.pages ?? 1;
  // A sixel is resent whenever its rows are redrawn, so animations stay on their first frame.
  const frameCount = !sixel && pages <= MAX_FRAMES && pages * sourceWidth * sourceHeight <= MAX_PIXELS ? pages : 1;
  const frames: ImageFrame[] = [];
  for (let page = 0; page < frameCount; page++) {
    signal?.throwIfAborted();
    const pipeline = sharp(source, { ...options, page, pages: 1 }).autoOrient();
    const png = graphics.protocol === "kitty" ? await pipeline.clone().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).png().toBuffer() : undefined;
    const strips = sixel ? await sixelStrips(pipeline.clone(), size, graphics.cell, background) : undefined;
    const { data, info } = await pipeline.resize(size.width, size.height * 2, { fit: "fill" })
      .flatten({ background }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    frames.push({ ansi: halfBlocks(data, info.width, info.height, info.channels), delay: Math.max(80, metadata.delay?.[page] ?? 100), ...(png ? { png } : {}), ...(strips ? { sixel: strips } : {}) });
  }
  if (benchmark.on) {
    benchmark.picture({
      width: sourceWidth, height: sourceHeight, columns: size.width, rows: size.height, protocol: graphics.protocol, ms: performance.now() - began,
      bytes: bytes.length, sixel: frames[0]?.sixel?.reduce((total, strip) => total + strip.length, 0) ?? 0,
    });
  }
  return { frames, ...size, still: pages > frameCount };
}

// Quantized once so every strip shares one palette; each strip then declares only the
// registers it uses.
async function sixelStrips(pipeline: Sharp, size: { width: number; height: number }, cell: CellSize, background: string): Promise<string[] | undefined> {
  const width = size.width * cell.width;
  const height = size.height * cell.height;
  if (width * height > MAX_SIXEL_PIXELS) return undefined;
  const png = await pipeline.resize(width, height, { fit: "fill" }).flatten({ background })
    .png({ palette: true, colours: 256, dither: 1, effort: 4 }).toBuffer();
  const image = decodeIndexedPng(png);
  return Array.from({ length: size.height }, (_, row) => encodeSixel(stripOf(image, row * cell.height, cell.height)));
}

function stripOf(image: IndexedImage, top: number, rows: number): IndexedImage {
  const height = Math.max(0, Math.min(rows, image.height - top));
  return { ...image, height, pixels: image.pixels.subarray(top * image.width, (top + height) * image.width) };
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

// The longest side, in pixels, a picture drawn in `columns` × `rows` cells can need, doubled
// so the last resize still has detail to work from. Converting a HEIC photo at its own 4096
// px meant writing and reading back a 25 MB PNG, about 1.5 s and 60 MB of memory, for a
// preview 360 px wide.
export function previewBound(graphics: Graphics, columns: number, rows: number): number {
  if (graphics.protocol === "kitty") return 2560;
  const cell = graphics.protocol === "sixel" ? graphics.cell : HALF_BLOCK_CELL;
  return Math.min(4096, Math.max(256, 2 * Math.max(columns * cell.width, rows * cell.height)));
}

async function convertHeic(source: Buffer, bound: number, signal?: AbortSignal): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "imsg-preview-"));
  try {
    const input = join(directory, "source.heic");
    const output = join(directory, "preview.png");
    await writeFile(input, source, { mode: 0o600 });
    // PNG keeps a sticker's transparency, for the canvas to show through.
    await run("/usr/bin/sips", ["-s", "format", "png", "--resampleHeightWidthMax", String(bound), input, "--out", output], { timeout: 15_000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) });
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

type NativeImage = { png?: Buffer | undefined; sixel?: string[] | undefined; measure: () => ImageArea | null };
// `shown` is where a sixel's strips were last drawn in full; `written` is where its
// placeholder sat in the last frame Ink wrote, which can trail the layout by a frame.
// `visible` is where its pixels are on screen now: frames only rewrite cells that changed,
// so when the picture moves or goes, its old cells are rewritten on purpose to clear them.
type RegisteredImage = NativeImage & {
  transmitted: boolean; placed: boolean; shown: ImageArea | null; written?: ImageArea | null;
  visible?: ImageArea | null;
  settle?: { timer: ReturnType<typeof setTimeout>; area: ImageArea } | undefined;
};
// Pixels of pictures that went away, cleared by the next frame.
const leftBehind: ImageArea[] = [];
const images = new Map<number, RegisteredImage>();
let nextImageId = 17000;
export function registerImage(image: NativeImage): () => void {
  const id = ++nextImageId;
  images.set(id, { ...image, transmitted: false, placed: false, shown: null });
  repaintImages();
  return () => {
    const removed = images.get(id);
    if (removed?.settle) clearTimeout(removed.settle.timer);
    if (removed?.visible) leftBehind.push(removed.visible);
    images.delete(id);
    // A sixel leaves with the text that Ink writes over it.
    if (process.stdout.isTTY && !removed?.sixel) process.stdout.write(deleteKittyImage(id));
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
    const protocol = activeGraphics().protocol;
    if (protocol === "kitty") paintImages();
    // Moved sixels are redrawn when Ink rewrites their rows; only new ones are drawn here.
    else if (protocol === "sixel") writeSixels(sixelRepaint(noDamage(), sixelTarget().rows ?? 24, sixelTarget().columns ?? 80, true));
  });
}

// A picture that is moving (scrolling) shows its placeholder until it rests this long, so a
// fast scroll does not resend every picture on every frame.
const SETTLE_MS = 120;

function sixelTarget(): NodeJS.WriteStream {
  return terminal ?? process.stdout;
}

function writeSixels(output: string): void {
  const target = sixelTarget();
  if (!output || !target.isTTY) return;
  if (benchmark.on) benchmark.sixel(output.length);
  target.write(output);
}

function sameArea(a: ImageArea, b: ImageArea): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// Restarted only while the picture keeps moving; other writes leave the timer alone.
function settleLater(image: RegisteredImage, area: ImageArea): void {
  if (image.settle && sameArea(image.settle.area, area)) return;
  if (image.settle) clearTimeout(image.settle.timer);
  image.settle = { area, timer: setTimeout(() => {
    image.settle = undefined;
    if (![...images.values()].includes(image) || !image.sixel) return;
    const target = sixelTarget();
    const area = sixelArea(image, target.rows ?? 24, target.columns ?? 80);
    if (!area) return;
    // Ink has not written this layout yet; drawing now would be erased by that frame.
    if (!image.written || !sameArea(image.written, area)) {
      settleLater(image, area);
      return;
    }
    image.shown = area;
    image.visible = area;
    writeSixels(`\x1b7${stripsAt(image.sixel, area, () => true)}\x1b8`);
  }, SETTLE_MS) };
}

function stripsAt(strips: string[], area: ImageArea, include: (row: number) => boolean): string {
  let output = "";
  for (let row = 0; row < area.height; row++) if (include(row)) output += `\x1b[${area.y + row + 1};${area.x + 1}H${strips[row]}`;
  return output;
}

// Draws the sixel strips an Ink write erased; onlyNew draws sixels not yet on screen. A moved
// picture waits to settle (its old cells were cleared as the frame was written). It must
// stay clear of the last row, since finishing an image there scrolls Ink's frame.
export function sixelRepaint(damage: Damage, rows: number, columns: number, onlyNew = false): string {
  let output = "";
  for (const image of images.values()) {
    if (!image.sixel) continue;
    const area = sixelArea(image, rows, columns);
    if (!onlyNew) image.written = area;
    if (!area) {
      image.shown = null;
      continue;
    }
    const shown = image.shown;
    if (shown && !sameArea(shown, area)) {
      if (!onlyNew) settleLater(image, area);
      continue;
    }
    // Back where it was drawn: the rewritten rows below are repainted now, so no settle is due.
    if (shown && image.settle && !onlyNew) {
      clearTimeout(image.settle.timer);
      image.settle = undefined;
    }
    if (onlyNew && shown) continue;
    // Only writes that reach the picture's own columns drop its pixels.
    const touched = (row: number) => damage.all || damage.rows.has(area.y + row) ||
      (damage.spans.get(area.y + row)?.some(([start, end]) => start < area.x + area.width && end > area.x) ?? false);
    // The first time every strip goes out, once a frame has written the placeholder. So does
    // a picture back where it was drawn whose cells were cleared, once a frame writes there:
    // the layout runs ahead of the frames, and drawing sooner would be written over. With no
    // such write yet it settles instead. Otherwise only the strips under rewritten cells go.
    const anyTouched = Array.from({ length: area.height }, (_, row) => touched(row)).some(Boolean);
    const onScreen = Boolean(image.visible && sameArea(image.visible, area));
    if (!onlyNew && shown && !onScreen && !anyTouched) {
      settleLater(image, area);
      continue;
    }
    const whole = onlyNew || !onScreen && anyTouched;
    output += stripsAt(image.sixel, area, (row) => whole || touched(row));
    if (whole) {
      image.shown = image.visible = area;
      if (image.settle) clearTimeout(image.settle.timer);
      image.settle = undefined;
    }
  }
  return output ? `\x1b7${output}\x1b8` : "";
}

function sixelArea(image: RegisteredImage, rows: number, columns: number): ImageArea | null {
  const area = image.measure();
  return area && image.sixel && area.x >= 0 && area.y >= 0 && area.width >= 1 && area.height >= 1 &&
    area.x + area.width <= columns && area.y + area.height < rows && area.height === image.sixel.length ? area : null;
}

// The sixels that belong on screen now, for checking what a terminal was sent.
export function sixelPlacements(rows: number, columns: number): { area: ImageArea; strips: string[] }[] {
  return [...images.values()].flatMap((image) => {
    const area = sixelArea(image, rows, columns);
    return area && image.sixel ? [{ area, strips: image.sixel }] : [];
  });
}

// Ink's stdout, with every write followed by the sixel strips it erased. They join the same
// write so a synchronized frame (BSU … ESU) shows text and pictures together.
let terminal: NodeJS.WriteStream | undefined;
export function trackTerminal(stream: NodeJS.WriteStream): NodeJS.WriteStream {
  terminal = stream;
  const tracker = new ScreenTracker(() => stream.rows ?? 24);
  const frames = new FrameDiff();
  let alternate = false;
  const decoder = new StringDecoder("utf8");
  // Ink writes each frame as three pieces (begin sync, frame, end sync). Over SSH with no
  // delay each write can become its own packet, costing more than a keystroke's changes, so
  // the writes of one turn of the event loop leave as one.
  let pending: (string | Uint8Array)[] = [];
  let queued = false;
  let framed = false;
  const take = (): Buffer => {
    const joined = Buffer.concat(pending.map((part) => typeof part === "string" ? Buffer.from(part) : part));
    pending = [];
    if (benchmark.on) benchmark.flushed(joined.length, framed);
    framed = false;
    return joined;
  };
  const write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    const rows = stream.rows ?? 24;
    const columns = stream.columns ?? 80;
    // In the alternate screen, Ink's frames go out as the cells that changed.
    const frame = alternate ? frameText(text) : undefined;
    if (frame !== undefined) clearMovedSixels(frames, rows, columns);
    const began = benchmark.on ? performance.now() : 0;
    const drawn = frame === undefined ? undefined : frames.render(frame, columns, rows);
    if (frame !== undefined) framed = true;
    if (benchmark.on && drawn) benchmark.diffed(performance.now() - began, Buffer.byteLength(drawn.output), drawn.damage.all);
    let data: string | Uint8Array = chunk;
    let damage: Damage;
    if (drawn) {
      data = drawn.output;
      damage = drawn.damage;
      tracker.feed(drawn.output);
    } else {
      damage = tracker.feed(text);
      if (text.includes("\x1b[?1049h")) alternate = true;
      if (text.includes("\x1b[?1049l")) alternate = false;
      // Anything else that changed the screen leaves the model of it behind.
      if (damage.all || damage.rows.size || frame !== undefined) frames.invalidate();
    }
    const repaint = activeGraphics().protocol === "sixel" ? sixelRepaint(damage, rows, columns) : "";
    if (benchmark.on && repaint) benchmark.sixel(repaint.length);
    pending.push(data, repaint);
    // A write that wants to know when it is done goes out now, with whatever came before it.
    if (rest.some((value) => typeof value === "function")) return Reflect.apply(stream.write, stream, [take(), ...rest]) as boolean;
    if (!queued) {
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const joined = take();
        if (joined.length) Reflect.apply(stream.write, stream, [joined]);
      });
    }
    return true;
  };
  return new Proxy(stream, {
    get(target, property) {
      if (property === "write") return write;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// A write only drops a picture from the cells it covers, and frames now skip unchanged
// cells, so the cells a sixel moved off or left behind are rewritten on purpose.
function clearMovedSixels(frames: FrameDiff, rows: number, columns: number): void {
  const force = (area: ImageArea) => {
    for (let row = area.y; row < area.y + area.height; row++) frames.force(row, area.x, area.x + area.width);
  };
  for (const area of leftBehind.splice(0)) force(area);
  for (const image of images.values()) {
    if (!image.visible) continue;
    const area = sixelArea(image, rows, columns);
    if (area && sameArea(area, image.visible)) continue;
    force(image.visible);
    image.visible = null;
  }
}

function paintImages(): void {
  for (const [id, image] of images) {
    if (!image.png) continue;
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
  for (const image of images.values()) if (image.settle) clearTimeout(image.settle.timer);
  if (process.stdout.isTTY) for (const [id, image] of images) if (!image.sixel) process.stdout.write(deleteKittyImage(id));
  images.clear();
}
