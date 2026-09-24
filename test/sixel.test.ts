import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { decodeIndexedPng, encodeSixel, type IndexedImage } from "../src/sixel.ts";

// Reads a sixel back into RGB pixels, the way a terminal does, so the encoder is checked
// against what would be drawn rather than against its own output format.
function decodeSixel(data: string): { width: number; height: number; rgb: (number | undefined)[][] } {
  const body = /^\x1bP0;1;0q"1;1;(\d+);(\d+)([\s\S]*)\x1b\\$/.exec(data);
  if (!body) throw new Error("unexpected sixel framing");
  const width = Number(body[1]);
  const height = Number(body[2]);
  const registers = new Map<number, number[]>();
  const rgb: (number | undefined)[][] = Array.from({ length: height }, () => Array<number | undefined>(width).fill(undefined));
  let color = 0;
  let x = 0;
  let band = 0;
  const text = body[3]!;
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (character === "#") {
      const match = /^#(\d+)(?:;2;(\d+);(\d+);(\d+))?/.exec(text.slice(index))!;
      color = Number(match[1]);
      if (match[2] !== undefined) registers.set(color, [Number(match[2]), Number(match[3]), Number(match[4])]);
      index += match[0].length;
    } else if (character === "$") { x = 0; index++; }
    else if (character === "-") { x = 0; band++; index++; }
    else {
      let count = 1;
      if (character === "!") {
        const match = /^!(\d+)/.exec(text.slice(index))!;
        count = Number(match[1]);
        index += match[0].length;
      }
      const bits = text.charCodeAt(index) - 63;
      if (bits < 0 || bits > 63) throw new Error(`bad sixel character ${text[index]}`);
      index++;
      for (let repeat = 0; repeat < count; repeat++, x++) {
        for (let row = 0; row < 6; row++) {
          if (!(bits & (1 << row))) continue;
          const y = band * 6 + row;
          if (y >= height || x >= width) throw new Error("pixel outside the raster");
          const value = registers.get(color)!;
          rgb[y]![x] = (value[0]! << 16) | (value[1]! << 8) | value[2]!;
        }
      }
    }
  }
  return { width, height, rgb };
}

const percent = (value: number) => Math.round(value * 100 / 255);

function expected(image: IndexedImage, x: number, y: number): number {
  const index = image.pixels[y * image.width + x]!;
  return (percent(image.palette[index * 3]!) << 16) | (percent(image.palette[index * 3 + 1]!) << 8) | percent(image.palette[index * 3 + 2]!);
}

describe("sixel encoding", () => {
  it("draws every pixel in its palette color, across partial bands and long runs", () => {
    const width = 37;
    const height = 20; // three full bands and a two-row one, like a 20px Windows Terminal cell
    const palette = new Uint8Array([0, 0, 0, 255, 255, 255, 200, 30, 10, 12, 180, 250]);
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = x < 20 ? (y * 7 + x * 3) % 4 : y % 4 === 0 ? 3 : 1;
    const image = { width, height, palette, pixels };
    const sixel = encodeSixel(image);
    expect(sixel).toMatch(/!\d+/);
    expect(sixel.endsWith("-\x1b\\")).toBe(false);
    const drawn = decodeSixel(sixel);
    expect([drawn.width, drawn.height]).toEqual([width, height]);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) expect(drawn.rgb[y]![x]).toBe(expected(image, x, y));
  });

  it("declares only the registers a strip uses", () => {
    const palette = new Uint8Array(256 * 3).map((_, index) => index % 256);
    const pixels = new Uint8Array(8 * 6).fill(200);
    const sixel = encodeSixel({ width: 8, height: 6, palette, pixels });
    expect(sixel.match(/#\d+;2;/g)).toEqual(["#200;2;"]);
  });

  it.each([256, 16, 4, 2])("reads sharp's %i-color palette PNGs like sharp does", async (colours) => {
    const raw = Buffer.alloc(23 * 11 * 3);
    for (let index = 0; index < 23 * 11; index++) raw.set([(index * 37) % 256, (index * 11) % 256, (index * 5) % 256], index * 3);
    const png = await sharp(raw, { raw: { width: 23, height: 11, channels: 3 } }).png({ palette: true, colours, dither: 0 }).toBuffer();
    const image = decodeIndexedPng(png);
    const reference = await sharp(png).removeAlpha().raw().toBuffer();
    expect([image.width, image.height]).toEqual([23, 11]);
    for (let index = 0; index < 23 * 11; index++) {
      const entry = image.pixels[index]! * 3;
      expect([...image.palette.subarray(entry, entry + 3)]).toEqual([...reference.subarray(index * 3, index * 3 + 3)]);
    }
  });

  it("refuses PNGs that are not palette images", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    expect(() => decodeIndexedPng(png)).toThrow(/palette/);
    expect(() => decodeIndexedPng(Buffer.from("nope"))).toThrow(/PNG/);
  });
});
