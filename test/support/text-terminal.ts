import stringWidth from "string-width";

// A terminal model for text: what each cell shows, in which colors and attributes, under
// which hyperlink. Enough of VT behavior (cursor moves, erases, SGR, OSC 8, wide characters)
// to check that a stream of partial updates leaves the same screen as drawing it whole.
// Kept separate from the code under test, so a shared mistake cannot hide.

export type Cell = { text: string; style: string; link: string };
const blank = (): Cell => ({ text: " ", style: "", link: "" });

type Style = { flags: number[]; fg: string; bg: string; ul: string; other: string[] };
const plain = (): Style => ({ flags: [], fg: "", bg: "", ul: "", other: [] });

export class TextTerminal {
  cells: Cell[][];
  bytes = 0;
  wraps = 0;
  private row = 0;
  private column = 0;
  private style = plain();
  private link = "";
  private pendingWrap = false;

  constructor(public columns: number, public rows: number) {
    this.cells = Array.from({ length: rows }, () => Array.from({ length: columns }, blank));
  }

  resize(columns: number, rows: number): void {
    this.cells = Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) => this.cells[y]?.[x] ?? blank()));
    this.columns = columns;
    this.rows = rows;
    this.row = Math.min(this.row, rows - 1);
    this.column = Math.min(this.column, columns - 1);
  }

  snapshot(): string[] {
    return this.cells.map((row) => row.map((cell) => `${cell.text}\u0000${cell.style}\u0000${cell.link}`).join("\u0001"));
  }

  feed(text: string): void {
    this.bytes += Buffer.byteLength(text);
    let index = 0;
    while (index < text.length) {
      const character = text[index]!;
      if (character === "\x1b") {
        const next = text[index + 1];
        if (next === "[") {
          let end = index + 2;
          while (end < text.length && !/[@-~]/.test(text[end]!)) end++;
          this.csi(text.slice(index + 2, end), text[end]!);
          index = end + 1;
        } else if (next === "]") {
          const bell = text.indexOf("\x07", index);
          const st = text.indexOf("\x1b\\", index);
          const end = bell >= 0 && (st < 0 || bell < st) ? bell : st;
          const body = text.slice(index + 2, end);
          if (body.startsWith("8;")) this.link = body.split(";").slice(2).join(";");
          index = end + (end === bell ? 1 : 2);
        } else index += 2;
        continue;
      }
      if (character === "\n") { this.row = Math.min(this.rows - 1, this.row + 1); this.column = 0; this.pendingWrap = false; index++; continue; }
      if (character === "\r") { this.column = 0; this.pendingWrap = false; index++; continue; }
      // One grapheme at a time; zero-width ones join the cell before.
      const segment = [...new Intl.Segmenter().segment(text.slice(index, index + 16))][0]!.segment;
      this.print(segment);
      index += segment.length;
    }
  }

  private print(segment: string): void {
    const width = stringWidth(segment);
    if (width === 0) {
      const cell = this.cells[this.row]?.[Math.max(0, this.column - 1)];
      if (cell) cell.text += segment;
      return;
    }
    if (this.pendingWrap) {
      // A real terminal wraps; the differ never relies on it, which the tests check.
      this.wraps += 1;
      this.pendingWrap = false;
      this.column = 0;
      this.row = Math.min(this.rows - 1, this.row + 1);
    }
    const line = this.cells[this.row]!;
    // Overwriting half of a wide character erases all of it.
    for (const x of [this.column, this.column + width - 1]) {
      if (line[x]?.text === "" && x > 0) line[x - 1] = blank();
      if (line[x + 1]?.text === "" && line[x]?.text !== "") line[x + 1] = blank();
    }
    const key = styleKey(this.style);
    line[this.column] = { text: segment, style: key, link: this.link };
    if (width === 2 && this.column + 1 < this.columns) line[this.column + 1] = { text: "", style: key, link: this.link };
    if (this.column + width >= this.columns) this.pendingWrap = true;
    else this.column += width;
  }

  private csi(parameters: string, final: string): void {
    const values = parameters.split(";").map((value) => Number.parseInt(value, 10));
    const first = Number.isFinite(values[0]) ? values[0]! : 0;
    this.pendingWrap = false;
    switch (final) {
      case "H": case "f":
        this.row = Math.min(this.rows - 1, Math.max(0, (first || 1) - 1));
        this.column = Math.min(this.columns - 1, Math.max(0, (Number.isFinite(values[1]) ? values[1]! : 1) - 1));
        break;
      case "A": this.row = Math.max(0, this.row - Math.max(1, first)); break;
      case "G": this.column = Math.min(this.columns - 1, Math.max(0, (first || 1) - 1)); break;
      case "K": {
        const line = this.cells[this.row]!;
        const [from, to] = first === 0 ? [this.column, this.columns] : first === 1 ? [0, this.column + 1] : [0, this.columns];
        for (let x = from; x < to; x++) line[x] = { ...blank(), style: backgroundOnly(this.style) };
        break;
      }
      case "J":
        if (first === 2) this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.columns }, () => ({ ...blank(), style: backgroundOnly(this.style) })));
        break;
      case "m": this.sgr(parameters); break;
    }
  }

  private sgr(parameters: string): void {
    const codes = parameters === "" ? ["0"] : parameters.split(";");
    for (let index = 0; index < codes.length; index++) {
      const code = Number(codes[index] || "0");
      const style = this.style;
      const flag = (value: number, on: boolean) => { style.flags = style.flags.filter((item) => item !== value); if (on) style.flags.push(value); };
      if (code === 0) this.style = plain();
      else if ([1, 2, 3, 4, 5, 7, 8, 9, 53].includes(code)) flag(code, true);
      else if (code === 22) { flag(1, false); flag(2, false); }
      else if ([23, 24, 25, 27, 28, 29].includes(code)) flag(code - 20, false);
      else if (code === 55) flag(53, false);
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.fg = `${code}`;
      else if (code === 39) style.fg = "";
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) style.bg = `${code}`;
      else if (code === 49) style.bg = "";
      else if (code === 38 || code === 48 || code === 58) {
        const count = codes[index + 1] === "5" ? 2 : 4;
        const color = codes.slice(index + 1, index + 1 + count).join(":");
        index += count;
        if (code === 38) style.fg = color; else if (code === 48) style.bg = color; else style.ul = color;
      } else if (code === 59) style.ul = "";
      else style.other.push(`${code}`);
    }
  }
}

function styleKey(style: Style): string {
  if (!style.flags.length && !style.fg && !style.bg && !style.ul && !style.other.length) return "";
  return JSON.stringify({ ...style, flags: [...style.flags].sort((a, b) => a - b) });
}

// Erased cells take the current background, and nothing else, from the style.
function backgroundOnly(style: Style): string {
  return style.bg ? styleKey({ ...plain(), bg: style.bg }) : "";
}
