import { inflateSync } from "node:zlib";

// Sixel output for terminals without the kitty graphics protocol, Windows Terminal among
// them. sharp quantizes the picture into a palette PNG; this reads its indices back and
// writes them as sixel bands.

export type IndexedImage = { width: number; height: number; palette: Uint8Array; pixels: Uint8Array };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Reads a non-interlaced palette PNG (color type 3) into one palette index per pixel.
export function decodeIndexedPng(png: Buffer): IndexedImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = -1;
  let palette: Buffer | undefined;
  const data: Buffer[] = [];
  for (let offset = 8; offset + 8 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > png.length) throw new Error("truncated PNG");
    if (type === "IHDR") {
      width = png.readUInt32BE(start);
      height = png.readUInt32BE(start + 4);
      depth = png[start + 8]!;
      colorType = png[start + 9]!;
      interlace = png[start + 12]!;
    } else if (type === "PLTE") palette = png.subarray(start, end);
    else if (type === "IDAT") data.push(png.subarray(start, end));
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (colorType !== 3 || interlace !== 0 || !palette || ![1, 2, 4, 8].includes(depth) || width < 1 || height < 1) {
    throw new Error("expected a non-interlaced palette PNG");
  }
  const stride = Math.ceil(width * depth / 8);
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG data");
  const pixels = new Uint8Array(width * height);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const filter = raw[row]!;
    for (let i = 0; i < stride; i++) {
      const left = i > 0 ? current[i - 1]! : 0;
      const up = previous[i]!;
      const value = raw[row + 1 + i]!;
      switch (filter) {
        case 0: current[i] = value; break;
        case 1: current[i] = value + left; break;
        case 2: current[i] = value + up; break;
        case 3: current[i] = value + ((left + up) >> 1); break;
        case 4: current[i] = value + paeth(left, up, i > 0 ? previous[i - 1]! : 0); break;
        default: throw new Error("invalid PNG filter");
      }
    }
    if (depth === 8) pixels.set(current.subarray(0, width), y * width);
    else {
      for (let x = 0; x < width; x++) {
        const shift = 8 - depth * (x % perByte + 1);
        pixels[y * width + x] = (current[Math.floor(x / perByte)]! >> shift) & mask;
      }
    }
    [previous, current] = [current, previous];
  }
  return { width, height, palette: new Uint8Array(palette), pixels };
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

// Each band is six pixel rows. A band is written one color at a time: `#n` selects the
// register, each character's six low bits say which rows of that column take the color,
// `!count` repeats a character, `$` returns to the band's start and `-` moves to the next.
// P2=1 leaves unpainted pixels transparent; the raster attributes fix a 1:1 pixel aspect.
export function encodeSixel(image: IndexedImage): string {
  const { width, height, palette, pixels } = image;
  const colors = Math.floor(palette.length / 3);
  const used = new Uint8Array(colors);
  for (const index of pixels) if (index < colors) used[index] = 1;
  const parts: string[] = [`\x1bP0;1;0q"1;1;${width};${height}`];
  for (let color = 0; color < colors; color++) {
    if (!used[color]) continue;
    const percent = (channel: number) => Math.round(palette[color * 3 + channel]! * 100 / 255);
    parts.push(`#${color};2;${percent(0)};${percent(1)};${percent(2)}`);
  }
  const masks = new Uint8Array(colors * width);
  const inBand = new Uint8Array(colors);
  for (let top = 0; top < height; top += 6) {
    masks.fill(0);
    inBand.fill(0);
    const rows = Math.min(6, height - top);
    for (let row = 0; row < rows; row++) {
      const bit = 1 << row;
      const base = (top + row) * width;
      for (let x = 0; x < width; x++) {
        const color = pixels[base + x]!;
        if (color >= colors) continue;
        masks[color * width + x]! |= bit;
        inBand[color] = 1;
      }
    }
    let first = true;
    for (let color = 0; color < colors; color++) {
      if (!inBand[color]) continue;
      const base = color * width;
      let end = width;
      while (end > 0 && masks[base + end - 1] === 0) end--;
      let line = first ? `#${color}` : `$#${color}`;
      first = false;
      for (let x = 0; x < end;) {
        const value = masks[base + x]!;
        let run = 1;
        while (x + run < end && masks[base + x + run] === value) run++;
        const character = String.fromCharCode(63 + value);
        line += run > 3 ? `!${run}${character}` : character.repeat(run);
        x += run;
      }
      parts.push(line);
    }
    if (top + 6 < height) parts.push("-");
  }
  parts.push("\x1b\\");
  return parts.join("");
}
