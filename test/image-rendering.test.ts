import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createElement } from "react";
import { render } from "ink";
import { cachedConversion, configureGraphics, decodeImage, deleteKittyImage, imageCellSize, kittyImage, previewBound, supportsNativeImages, registerImage, repaintImages, cleanupImages } from "../src/image-rendering.ts";

describe("image rendering", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)("decodes real %s bytes into colored pixels, and a PNG for kitty", async format => {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#ff3300" } }).toFormat(format).toBuffer();
    const result = await decodeImage(bytes, 6, 4);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.ansi).toContain("▄");
    expect(result.frames[0]?.ansi).toContain("\x1b[48;2;");
    expect(result.frames[0]?.ansi).not.toContain("undefined");
    expect(result.frames[0]?.png).toBeUndefined();
    expect(result.width).toBeLessThanOrEqual(6);
    expect(result.height).toBeLessThanOrEqual(4);
    configureGraphics({ protocol: "kitty", cell: { width: 10, height: 20 } });
    try {
      const native = await decodeImage(bytes, 6, 4);
      expect((await sharp(native.frames[0]?.png).metadata()).format).toBe("png");
    } finally { configureGraphics(undefined); }
  });

  it("cuts a sixel into one strip per cell row, sized to cover its placeholder", async () => {
    const bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#3366cc" } }).png().toBuffer();
    configureGraphics({ protocol: "sixel", cell: { width: 10, height: 20 } });
    try {
      const image = await decodeImage(bytes, 48, 10);
      // 300×200 on 10×20 cells: 30 columns by 10 rows, at 300×200 pixels.
      expect([image.width, image.height]).toEqual([30, 10]);
      const strips = image.frames[0]?.sixel ?? [];
      expect(strips).toHaveLength(10);
      for (const strip of strips) expect(strip).toMatch(/^\x1bP0;1;0q"1;1;300;20#/);
      expect(image.frames[0]?.ansi.split("\n")).toHaveLength(10);
      expect(image.frames[0]?.png).toBeUndefined();
    } finally { configureGraphics(undefined); }
  });

  it("keeps an animation on its first frame for sixel, which is resent on every redraw", async () => {
    const data = Buffer.concat([Buffer.from([255, 0, 0, 255, 0, 0]), Buffer.from([0, 0, 255, 0, 0, 255])]);
    const bytes = await sharp(data, { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [120, 240], loop: 0 }).toBuffer();
    configureGraphics({ protocol: "sixel", cell: { width: 10, height: 20 } });
    try {
      const image = await decodeImage(bytes, 4, 2);
      expect(image.frames).toHaveLength(1);
      expect(image.still).toBe(true);
    } finally { configureGraphics(undefined); }
  });

  it("decodes distinct animated GIF frames with delays", async () => {
    const data = Buffer.concat([Buffer.from([255, 0, 0, 255, 0, 0]), Buffer.from([0, 0, 255, 0, 0, 255])]);
    const bytes = await sharp(data, { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [120, 240], loop: 0 }).toBuffer();
    const result = await decodeImage(bytes, 4, 2);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]?.ansi).not.toBe(result.frames[1]?.ansi);
    expect(result.frames.map(frame => frame.delay)).toEqual([120, 240]);
  });

  it.skipIf(process.platform !== "darwin")("decodes a real HEIC photo through macOS when libvips lacks HEVC", async () => {
    const bytes = Buffer.from("AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABw21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5mlwcnAAAADFaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAAgAAAAGAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABxaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAjQgEBA3AAAAMAsAAAAwAAAwAeoBQgQcCDCuIe5FlU3AgIGAKiAAEACUQBwGFyyERTZAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAsaWxvYwAAAABEAAACAAEAAAABAAACQwAAAD8AAgAAAAEAAAH3AAAATAAAAAFtZGF0AAAAAAAAAJsAAAAGRXhpZgAATU0AKgAAAAgAAwEaAAUAAAABAAAAMgEbAAUAAAABAAAAOgEoAAMAAAABAAIAAAAAAAAAAAAZAAAAAQAAABkAAAABAAAAOygBr6L6RoF8//3az//25fsv0Ao9V/+0J8j5u7L/plD3TLJn+iD5wjneHPDmc+/25UIvYV+CtwhJsiuA", "base64");
    const image = await decodeImage(bytes, 12, 8);
    expect(image.frames[0]?.ansi).toContain("▄");
  });

  it("rejects malformed and oversized image buffers", async () => {
    await expect(decodeImage(Buffer.from("not an image"), 10, 10)).rejects.toThrow();
    await expect(decodeImage(new Uint8Array(32 * 1024 * 1024 + 1), 10, 10)).rejects.toThrow("32 MB");
  });

  it("fits both portrait and landscape images in terminal cells", () => {
    expect(imageCellSize(100, 200, 20, 10)).toEqual({ width: 10, height: 10 });
    expect(imageCellSize(200, 100, 20, 10)).toEqual({ width: 20, height: 5 });
  });

  it("converts a HEIC photo at the size it is drawn, not its own", () => {
    const cell = { width: 10, height: 20 };
    // A 36 x 10 cell sixel preview is 360 x 200 px; a photo of any shape fits in 360.
    expect(previewBound({ protocol: "sixel", cell }, 36, 10)).toBe(360);
    // The full-screen viewer at 211 x 57 is 2070 px wide.
    expect(previewBound({ protocol: "sixel", cell }, 207, 53)).toBe(2070);
    expect(previewBound({ protocol: "blocks", cell }, 36, 10)).toBe(256);
    expect(previewBound({ protocol: "kitty", cell }, 36, 10)).toBe(2560);
  });

  it("keeps each HEIC conversion, by content and size, most recently used first", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuimsg-conversions-"));
    try {
      let conversions = 0;
      const convert = (fill: number) => async () => { conversions += 1; return Buffer.alloc(1_000, fill); };
      const photo = Buffer.from("photo one");
      expect(await cachedConversion(photo, 360, convert(1), directory)).toEqual(Buffer.alloc(1_000, 1));
      expect(await cachedConversion(Buffer.from("photo one"), 360, convert(9), directory)).toEqual(Buffer.alloc(1_000, 1));
      expect(conversions).toBe(1);
      // Another size is another conversion.
      await cachedConversion(photo, 2070, convert(2), directory);
      expect(conversions).toBe(2);
      // Past the limit the least recently used go.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cachedConversion(photo, 360, convert(9), directory);
      await cachedConversion(Buffer.from("photo two"), 360, convert(3), directory, 2_500);
      expect((await readdir(directory)).filter((name) => name.endsWith(".png"))).toHaveLength(2);
      await cachedConversion(photo, 2070, convert(4), directory, 2_500);
      expect(conversions).toBe(4);
      // A converter that fails leaves nothing behind.
      await expect(cachedConversion(Buffer.from("broken"), 360, async () => { throw new Error("sips failed"); }, directory)).rejects.toThrow("sips failed");
      expect((await readdir(directory)).some((name) => name.includes("partial"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("only selects native graphics on known terminals outside tmux", () => {
    expect(supportsNativeImages({ TERM: "xterm-kitty" }, true)).toBe(true);
    expect(supportsNativeImages({ TERM_PROGRAM: "ghostty" }, true)).toBe(true);
    expect(supportsNativeImages({ TERM_PROGRAM: "iTerm.app" }, true)).toBe(false);
    expect(supportsNativeImages({ TERM: "xterm-kitty", TMUX: "/tmp/tmux" }, true)).toBe(false);
    expect(supportsNativeImages({ TERM: "xterm-kitty" }, false)).toBe(false);
  });

  it("positions native PNG chunks without moving Ink's cursor and deletes only owned images", () => {
    const bytes = Buffer.alloc(9000, 13);
    const output = kittyImage(bytes, 17001, { x: 8, y: 4, width: 20, height: 10 });
    expect(output.startsWith("\x1b7\x1b[5;9H")).toBe(true);
    expect(output.endsWith("\x1b8")).toBe(true);
    expect(output).toContain("i=17001,c=20,r=10,C=1,m=1");
    const chunks = [...output.matchAll(/\x1b_G[^;]+;([^\x1b]+)\x1b\\/g)].map(match => match[1]);
    expect(Buffer.from(chunks.join(""), "base64")).toEqual(bytes);
    expect(deleteKittyImage(17001)).toBe("\x1b_Ga=d,d=I,i=17001,q=2\x1b\\");
  });
});


it("paints native images after Ink output and reuses transmitted data on later frames", async () => {
  const chunks: string[] = [];
  const descriptors = Object.getOwnPropertyDescriptors(process.stdout);
  const oldWrite = process.stdout.write;
  const oldTerm = process.env.TERM;
  const oldTmux = process.env.TMUX;
  let app: ReturnType<typeof render> | undefined;
  try {
    for (const [key, value] of Object.entries({ isTTY: true, columns: 60, rows: 20 })) Object.defineProperty(process.stdout, key, { value, configurable: true });
    process.stdout.write = chunk => { chunks.push(String(chunk)); return true; };
    process.env.TERM = "xterm-kitty";
    delete process.env.TMUX;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    let visible = true;
    const unregister = registerImage({ png, measure: () => visible ? { x: 2, y: 2, width: 4, height: 2 } : null });
    const { Text } = await import("ink");
    app = render(createElement(Text, {}, "MARKER \x1b[48;2;255;0;0m▄\x1b[0m"), { stdout: process.stdout, stdin: process.stdin, patchConsole: false, onRender: repaintImages, interactive: true });
    await new Promise(resolve => setTimeout(resolve, 60));
    const first = chunks.join("");
    expect(first.indexOf("MARKER")).toBeGreaterThanOrEqual(0);
    expect(first.indexOf("MARKER")).toBeLessThan(first.indexOf("\x1b_Ga=T"));
    expect(first).toContain("48;2;255;0;0");
    chunks.length = 0;
    app.rerender(createElement(Text, {}, "SECOND"));
    await new Promise(resolve => setTimeout(resolve, 60));
    const second = chunks.join("");
    expect(second).toContain("a=p");
    expect(second).not.toContain("a=T");
    chunks.length = 0;
    visible = false;
    repaintImages();
    await new Promise(resolve => setImmediate(resolve));
    expect(chunks.join("")).toContain("a=d,d=i");
    chunks.length = 0;
    repaintImages();
    await new Promise(resolve => setImmediate(resolve));
    repaintImages();
    await new Promise(resolve => setImmediate(resolve));
    expect(chunks.join("")).toBe("");
    visible = true;
    repaintImages();
    await new Promise(resolve => setImmediate(resolve));
    expect(chunks.join("")).toContain("a=p");
    expect(chunks.join("")).not.toContain("a=T");
    expect(chunks.join("")).not.toContain("a=d");
    unregister();
    expect(chunks.join("")).toContain("a=d,d=I");
  } finally {
    cleanupImages();
    app?.unmount();
    process.stdout.write = oldWrite;
    for (const key of ["isTTY", "columns", "rows"]) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else Reflect.deleteProperty(process.stdout, key);
    }
    if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
    if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
  }
});

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition was not reached");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it("loads pixels only after an inline preview enters its clipped viewport", async () => {
  const { render: renderTest } = await import("ink-testing-library");
  const { Box, Text } = await import("ink");
  const { ImagePreview } = await import("../src/ui/ImagePreview.tsx");
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
  let loads = 0;
  const loadAttachment = async () => { loads++; return png; };
  const preview = createElement(ImagePreview, { attachment: { guid: "viewport-image", name: "photo.png", mime: "image/png", bytes: png.length }, loadAttachment, width: 4, height: 2 });
  const tree = (offset: number) => createElement(Box, { height: 4, width: 10, overflow: "hidden", flexDirection: "column" }, createElement(Box, { height: offset, flexShrink: 0 }), preview);
  const app = renderTest(tree(10));
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(loads).toBe(0);
    app.rerender(tree(0));
    // Decoding takes as long as the machine needs, so wait for the pixels, not a fixed time.
    await until(() => app.lastFrame()?.includes("▄") ?? false);
    expect(loads).toBe(1);
    app.rerender(createElement(Box, { flexDirection: "column" },
      createElement(Box, { height: 1, width: 10, overflow: "hidden", flexDirection: "column" }, preview),
      createElement(Text, {}, "FOOTER")));
    await until(() => {
      const [first, second] = app.lastFrame()?.split("\n") ?? [];
      return Boolean(first?.includes("▄")) && second === "FOOTER";
    });
    const lines = app.lastFrame()?.split("\n") ?? [];
    expect(lines[0]).toContain("▄");
    expect(lines[1]).toBe("FOOTER");
    expect(lines.slice(1).join("\n")).not.toContain("▄");
  } finally { app.unmount(); }
});
