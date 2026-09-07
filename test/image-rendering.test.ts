import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createElement } from "react";
import { render } from "ink";
import { decodeImage, deleteKittyImage, imageCellSize, kittyImage, supportsNativeImages, registerImage, repaintImages, cleanupImages } from "../src/image-rendering.ts";

describe("image rendering", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)("decodes real %s bytes into colored pixels and native PNG", async format => {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#ff3300" } }).toFormat(format).toBuffer();
    const result = await decodeImage(bytes, 6, 4);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.ansi).toContain("▄");
    expect(result.frames[0]?.ansi).toContain("\x1b[48;2;");
    expect(result.frames[0]?.ansi).not.toContain("undefined");
    expect((await sharp(result.frames[0]?.png).metadata()).format).toBe("png");
    expect(result.width).toBeLessThanOrEqual(6);
    expect(result.height).toBeLessThanOrEqual(4);
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
    expect((await sharp(image.frames[0]?.png).metadata()).format).toBe("png");
  });

  it("rejects malformed and oversized image buffers", async () => {
    await expect(decodeImage(Buffer.from("not an image"), 10, 10)).rejects.toThrow();
    await expect(decodeImage(new Uint8Array(32 * 1024 * 1024 + 1), 10, 10)).rejects.toThrow("32 MB");
  });

  it("fits both portrait and landscape images in terminal cells", () => {
    expect(imageCellSize(100, 200, 20, 10)).toEqual({ width: 10, height: 10 });
    expect(imageCellSize(200, 100, 20, 10)).toEqual({ width: 20, height: 5 });
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
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(loads).toBe(1);
    expect(app.lastFrame()).toContain("▄");
    app.rerender(createElement(Box, { flexDirection: "column" },
      createElement(Box, { height: 1, width: 10, overflow: "hidden", flexDirection: "column" }, preview),
      createElement(Text, {}, "FOOTER")));
    await new Promise(resolve => setTimeout(resolve, 80));
    const lines = app.lastFrame()?.split("\n") ?? [];
    expect(lines[0]).toContain("▄");
    expect(lines[1]).toBe("FOOTER");
    expect(lines.slice(1).join("\n")).not.toContain("▄");
  } finally { app.unmount(); }
});
