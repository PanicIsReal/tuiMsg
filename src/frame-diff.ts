import rememberedWidth from "./text-width.ts";

// Ink rewrites every changed line in full, colors and all, so moving a highlight one row
// resends about 5 KB, and every sixel strip on those lines has to follow. This keeps a model
// of the cells on screen and sends only the cells that changed, each run placed with an
// absolute cursor move. Over SSH that is the difference between a keypress costing a few
// hundred bytes and several kilobytes.

export type Span = [start: number, end: number];
// What a write changed on screen: everything, whole rows, or runs of cells.
export type Damage = { all: boolean; rows: Set<number>; spans: Map<number, Span[]> };
export const noDamage = (): Damage => ({ all: false, rows: new Set(), spans: new Map() });

// One screen row: per cell, its text ("" for the second half of a wide character), its SGR
// parameters in a canonical order ("" for the default style), and its hyperlink.
type Row = { line: string; text: string[]; style: string[]; link: string[] };

// Ink's standard log-update writes each frame as an erase of the last one, then the lines.
const ERASE = /^(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G/;
// Frames hold text, SGR and OSC 8 hyperlinks; anything else is not a frame this can model.
const FRAME = /^(?:[^\x1b\r\t\x00-\x09\x0b-\x1f]|\x1b\[[\d;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))*$/;
const PLAIN = /^[\x20-\x7e]*$/;
// Rewriting a few unchanged cells costs less than moving the cursor past them.
const MERGE_GAP = 4;
const LINE_CACHE = 4_000;

export function frameText(write: string): string | undefined {
  const erase = ERASE.exec(write);
  const frame = erase ? write.slice(erase[0].length) : write;
  if (!erase && !frame) return undefined;
  return FRAME.test(frame) ? frame : undefined;
}

export class FrameDiff {
  private screen: Row[] | undefined;
  private size = { columns: 0, rows: 0 };
  private readonly forced = new Map<number, Span[]>();
  private readonly lines = new Map<string, Row>();

  // Forgets what is on screen, so the next frame is drawn whole.
  invalidate(): void {
    this.screen = undefined;
  }

  // Cells to rewrite in the next frame whatever they hold, such as ones under a sixel that
  // moved away: only a write drops a picture from a cell.
  force(row: number, start: number, end: number): void {
    const spans = this.forced.get(row) ?? [];
    spans.push([start, end]);
    this.forced.set(row, spans);
  }

  // The output that turns the screen into `frame`, or undefined when the frame does not fit
  // (Ink then clears the terminal itself, and the screen is modeled afresh).
  render(frame: string, columns: number, rows: number): { output: string; damage: Damage } | undefined {
    const lines = frame.split("\n");
    if (lines.length > rows) return undefined;
    const damage = noDamage();
    let output = "";
    let screen = this.screen;
    if (!screen || this.size.columns !== columns || this.size.rows !== rows) {
      output += "\x1b[0m\x1b[H\x1b[2J";
      screen = [];
      damage.all = true;
      this.forced.clear();
    }
    const next = lines.map((line) => this.parse(line));
    let style = "";
    for (let y = 0; y < rows; y++) {
      const before = screen[y];
      const after = next[y];
      const forced = this.forced.get(y);
      if (!before && !after) continue;
      if (before && after && before.line === after.line && !forced) continue;
      if (!after) {
        output += `\x1b[${y + 1};1H${style ? "\x1b[0m" : ""}\x1b[2K`;
        style = "";
        damage.spans.set(y, [[0, columns]]);
        continue;
      }
      const runs = changedRuns(before, after, columns, forced);
      if (!runs.length) continue;
      const spans: Span[] = [];
      damage.spans.set(y, spans);
      for (const [start, end] of runs) {
        spans.push([start, end]);
        output += `\x1b[${y + 1};${start + 1}H`;
        let link = "";
        const content = Math.min(end, after.text.length);
        for (let x = start; x < content; x++) {
          const text = after.text[x]!;
          if (text === "") continue;
          if (after.style[x] !== style) {
            style = after.style[x]!;
            output += style ? `\x1b[0;${style}m` : "\x1b[0m";
          }
          if (after.link[x] !== link) {
            link = after.link[x]!;
            output += `\x1b]8;;${link}\x1b\\`;
          }
          output += text;
        }
        if (link) output += "\x1b]8;;\x1b\\";
        // Past the end of the new line everything is blank; erasing clears the rest in one go.
        if (end > content) {
          if (style) output += "\x1b[0m";
          style = "";
          output += "\x1b[K";
          spans[spans.length - 1]![1] = columns;
        }
      }
    }
    if (style) output += "\x1b[0m";
    // Ink's next erase counts up from the last line of the frame it believes it wrote.
    output += `\x1b[${Math.min(rows, lines.length)};1H`;
    this.screen = next;
    this.size = { columns, rows };
    this.forced.clear();
    return { output, damage };
  }

  private parse(line: string): Row {
    let row = this.lines.get(line);
    if (!row) {
      row = parseLine(line);
      if (this.lines.size >= LINE_CACHE) this.lines.clear();
      this.lines.set(line, row);
    }
    return row;
  }
}

function cellEqual(before: Row | undefined, after: Row, x: number): boolean {
  const beforeText = before?.text[x] ?? " ";
  const afterText = after.text[x] ?? " ";
  return beforeText === afterText && (before?.style[x] ?? "") === (after.style[x] ?? "") && (before?.link[x] ?? "") === (after.link[x] ?? "");
}

function changedRuns(before: Row | undefined, after: Row, columns: number, forced: Span[] | undefined): Span[] {
  const width = Math.min(columns, Math.max(before?.text.length ?? 0, after.text.length, ...(forced ?? []).map(([, end]) => end)));
  const runs: Span[] = [];
  let start = -1;
  let lastChanged = -1;
  for (let x = 0; x < width; x++) {
    const changed = !cellEqual(before, after, x) || (forced?.some(([from, to]) => x >= from && x < to) ?? false);
    if (!changed) continue;
    if (start >= 0 && x - lastChanged <= MERGE_GAP) { lastChanged = x; continue; }
    if (start >= 0) runs.push([start, lastChanged + 1]);
    start = x;
    lastChanged = x;
  }
  if (start >= 0) runs.push([start, lastChanged + 1]);
  // A wide character is written and erased whole, so a run never splits one, before or after.
  const grown = runs.map(([from, to]) => {
    let first = from;
    let last = to;
    for (;;) {
      const grow = (first > 0 && (after.text[first] === "" || before?.text[first] === "")) || (last < width && (after.text[last] === "" || before?.text[last] === ""));
      if (!grow) break;
      if (first > 0 && (after.text[first] === "" || before?.text[first] === "")) first -= 1;
      if (last < width && (after.text[last] === "" || before?.text[last] === "")) last += 1;
    }
    return [first, last] as Span;
  });
  const merged: Span[] = [];
  for (const run of grown) {
    const previous = merged.at(-1);
    if (previous && run[0] <= previous[1]) previous[1] = Math.max(previous[1], run[1]);
    else merged.push(run);
  }
  return merged;
}

const segmenter = new Intl.Segmenter();

export function parseLine(line: string): Row {
  const row: Row = { line, text: [], style: [], link: [] };
  const sgr = new Sgr();
  let style = "";
  let link = "";
  let index = 0;
  const push = (text: string, width: number) => {
    if (width === 0) {
      if (row.text.length) row.text[row.text.length - 1] += text;
      return;
    }
    row.text.push(text);
    row.style.push(style);
    row.link.push(link);
    if (width === 2) {
      row.text.push("");
      row.style.push(style);
      row.link.push(link);
    }
  };
  while (index < line.length) {
    if (line.charCodeAt(index) === 0x1b) {
      if (line[index + 1] === "[") {
        let end = index + 2;
        while (end < line.length && !(line.charCodeAt(end) >= 0x40 && line.charCodeAt(end) <= 0x7e)) end++;
        if (line[end] === "m") {
          sgr.apply(line.slice(index + 2, end));
          style = sgr.key();
        }
        index = end + 1;
      } else if (line[index + 1] === "]") {
        const bell = line.indexOf("\x07", index);
        const st = line.indexOf("\x1b\\", index);
        const end = bell >= 0 && (st < 0 || bell < st) ? bell : st;
        if (end < 0) break;
        const body = line.slice(index + 2, end);
        if (body.startsWith("8;")) link = body.slice(body.indexOf(";", 2) + 1);
        index = end + (end === bell ? 1 : 2);
      } else {
        index += 2;
      }
      continue;
    }
    let end = line.indexOf("\x1b", index);
    if (end < 0) end = line.length;
    const text = line.slice(index, end);
    if (PLAIN.test(text)) for (const character of text) push(character, 1);
    else for (const { segment } of segmenter.segment(text)) push(segment, rememberedWidth(segment));
    index = end;
  }
  return row;
}

// The SGR state that a sequence of codes leaves, written back as one canonical parameter
// list, so two ways of reaching the same style compare equal.
const FLAGS: Record<string, [number, boolean]> = {
  "1": [1, true], "2": [2, true], "3": [3, true], "4": [4, true], "5": [5, true], "7": [7, true], "8": [8, true], "9": [9, true], "53": [53, true],
  "23": [3, false], "24": [4, false], "25": [5, false], "27": [7, false], "28": [8, false], "29": [9, false], "55": [53, false],
};

class Sgr {
  private flags = new Set<number>();
  private foreground = "";
  private background = "";
  private underline = "";
  private extra: string[] = [];

  apply(parameters: string): void {
    const codes = parameters === "" ? ["0"] : parameters.split(";");
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index] === "" ? "0" : codes[index]!;
      const number = Number(code);
      if (code === "0") this.reset();
      else if (FLAGS[code]) {
        const [flag, on] = FLAGS[code]!;
        if (on) this.flags.add(flag); else this.flags.delete(flag);
      } else if (code === "22") { this.flags.delete(1); this.flags.delete(2); }
      else if ((number >= 30 && number <= 37) || (number >= 90 && number <= 97)) this.foreground = code;
      else if (code === "39") this.foreground = "";
      else if ((number >= 40 && number <= 47) || (number >= 100 && number <= 107)) this.background = code;
      else if (code === "49") this.background = "";
      else if (code === "59") this.underline = "";
      else if (code === "38" || code === "48" || code === "58") {
        const mode = codes[index + 1];
        const take = mode === "5" ? 2 : mode === "2" ? 4 : 1;
        const color = codes.slice(index, index + 1 + take).join(";");
        index += take;
        if (code === "38") this.foreground = color;
        else if (code === "48") this.background = color;
        else this.underline = color;
      } else if (/^(?:38|48|58):/.test(code)) {
        if (code.startsWith("38")) this.foreground = code;
        else if (code.startsWith("48")) this.background = code;
        else this.underline = code;
      } else if (code.startsWith("4:")) {
        if (code === "4:0") this.flags.delete(4);
        else { this.flags.delete(4); this.extra = this.extra.filter((value) => !value.startsWith("4:")).concat(code); }
      } else if (!this.extra.includes(code)) this.extra.push(code);
    }
  }

  key(): string {
    return [...[...this.flags].sort((a, b) => a - b).map(String), this.foreground, this.background, this.underline, ...this.extra].filter(Boolean).join(";");
  }

  private reset(): void {
    this.flags.clear();
    this.foreground = "";
    this.background = "";
    this.underline = "";
    this.extra = [];
  }
}
