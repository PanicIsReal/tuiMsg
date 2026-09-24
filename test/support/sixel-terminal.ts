// A terminal model with Windows Terminal's sixel rules, read from its source
// (microsoft/terminal: TextBuffer::Replace, FillRect and SixelParser):
// - writing or erasing text in a cell drops the image content in that cell;
// - an image is drawn from the cursor, covering whole cells, on top of the text;
// - afterwards the cursor sits on the row holding the top of the last sixel band;
// - an image reaching past the bottom row scrolls the screen.
// It tracks, per cell, which sixel strip is showing, so tests can check that what the
// app believes is on screen is what a terminal would show.

export class SixelTerminal {
  readonly cells: (string | undefined)[][];
  scrolls = 0;
  wraps = 0;
  sixelBytes = 0;
  private row = 0;
  private column = 0;
  private saved = { row: 0, column: 0 };
  private state: "ground" | "escape" | "intermediate" | "csi" | "string" | "string-escape" = "ground";
  private params = "";
  private stringKind = "";
  private stringData = "";
  private pendingWrap = false;

  constructor(public columns: number, public rows: number, readonly cell = { width: 10, height: 20 }) {
    this.cells = Array.from({ length: rows }, () => Array<string | undefined>(columns).fill(undefined));
  }

  // The alternate screen keeps what still fits; nothing reflows.
  resize(columns: number, rows: number): void {
    this.cells.length = Math.min(this.cells.length, rows);
    for (const row of this.cells) { row.length = Math.min(row.length, columns); while (row.length < columns) row.push(undefined); }
    while (this.cells.length < rows) this.cells.push(Array<string | undefined>(columns).fill(undefined));
    this.columns = columns;
    this.rows = rows;
    this.row = Math.min(this.row, rows - 1);
    this.column = Math.min(this.column, columns - 1);
  }

  feed(text: string): void {
    for (const character of text) this.step(character);
  }

  private step(character: string): void {
    const code = character.codePointAt(0)!;
    switch (this.state) {
      case "ground":
        if (code === 0x1b) this.state = "escape";
        else if (code === 0x0a) { this.lineFeed(); this.column = 0; }
        else if (code === 0x0d) { this.column = 0; this.pendingWrap = false; }
        else if (code >= 0x20 && code !== 0x7f) this.print();
        return;
      case "escape":
        this.state = "ground";
        if (character === "[") { this.state = "csi"; this.params = ""; }
        else if ("]P_^X".includes(character)) { this.state = "string"; this.stringKind = character; this.stringData = ""; }
        else if (code >= 0x20 && code <= 0x2f) this.state = "intermediate";
        else if (character === "7") this.saved = { row: this.row, column: this.column };
        else if (character === "8") { this.row = this.saved.row; this.column = this.saved.column; this.pendingWrap = false; }
        return;
      case "intermediate":
        if (code < 0x20 || code > 0x2f) this.state = "ground";
        return;
      case "csi":
        if (code >= 0x40 && code <= 0x7e) { this.state = "ground"; this.csi(character); }
        else this.params += character;
        return;
      case "string":
        if (code === 0x1b) this.state = "string-escape";
        else if (code === 0x07 && this.stringKind === "]") this.state = "ground";
        else this.stringData += character;
        return;
      case "string-escape":
        if (character === "\\") {
          this.state = "ground";
          if (this.stringKind === "P") this.dcs(this.stringData);
        } else { this.state = "string"; this.stringData += `\x1b${character}`; }
        return;
    }
  }

  private print(): void {
    if (this.pendingWrap) {
      this.wraps += 1;
      this.pendingWrap = false;
      this.column = 0;
      this.lineFeed();
    }
    this.cells[this.row]![this.column] = undefined;
    if (this.column === this.columns - 1) this.pendingWrap = true;
    else this.column += 1;
  }

  private lineFeed(): void {
    this.pendingWrap = false;
    if (this.row < this.rows - 1) { this.row += 1; return; }
    this.scrolls += 1;
    this.cells.shift();
    this.cells.push(Array<string | undefined>(this.columns).fill(undefined));
  }

  private csi(final: string): void {
    const privateMarker = /^[<=>?]/.test(this.params);
    const values = (privateMarker ? this.params.slice(1) : this.params).split(";").map((value) => Number.parseInt(value, 10));
    const first = Number.isFinite(values[0]) ? values[0]! : 0;
    const count = Math.max(1, first);
    this.pendingWrap = false;
    if (privateMarker) {
      if ((final === "h" || final === "l") && values.includes(1049)) this.erase(0, 0, this.rows - 1, this.columns);
      return;
    }
    switch (final) {
      case "A": this.row = Math.max(0, this.row - count); break;
      case "B": this.row = Math.min(this.rows - 1, this.row + count); break;
      case "C": this.column = Math.min(this.columns - 1, this.column + count); break;
      case "D": this.column = Math.max(0, this.column - count); break;
      case "E": this.row = Math.min(this.rows - 1, this.row + count); this.column = 0; break;
      case "F": this.row = Math.max(0, this.row - count); this.column = 0; break;
      case "G": this.column = Math.min(this.columns - 1, count - 1); break;
      case "H": case "f": {
        this.row = Math.min(this.rows - 1, count - 1);
        this.column = Math.min(this.columns - 1, Math.max(1, Number.isFinite(values[1]) ? values[1]! : 1) - 1);
        break;
      }
      case "K":
        if (first === 0) this.erase(this.row, this.column, this.row, this.columns);
        else if (first === 1) this.erase(this.row, 0, this.row, this.column + 1);
        else this.erase(this.row, 0, this.row, this.columns);
        break;
      case "J":
        if (first === 0) { this.erase(this.row, this.column, this.row, this.columns); this.erase(this.row + 1, 0, this.rows - 1, this.columns); }
        else if (first === 1) { this.erase(0, 0, this.row - 1, this.columns); this.erase(this.row, 0, this.row, this.column + 1); }
        else this.erase(0, 0, this.rows - 1, this.columns);
        break;
      case "X": this.erase(this.row, this.column, this.row, Math.min(this.columns, this.column + count)); break;
    }
  }

  // Clears rows top..bottom (inclusive), columns [left, right) on each.
  private erase(top: number, left: number, bottom: number, right: number): void {
    for (let row = Math.max(0, top); row <= Math.min(this.rows - 1, bottom); row++) {
      for (let column = left; column < right; column++) this.cells[row]![column] = undefined;
    }
  }

  private dcs(data: string): void {
    const sixel = /^[\d;]*q"1;1;(\d+);(\d+)/.exec(data);
    if (!sixel) return;
    this.sixelBytes += data.length + 4;
    const width = Number(sixel[1]);
    const height = Number(sixel[2]);
    const bands = Math.ceil(height / 6);
    // The last band may run past the raster; if it runs past the screen, the screen scrolls.
    if (this.row * this.cell.height + bands * 6 > this.rows * this.cell.height) this.scrolls += 1;
    const id = `\x1bP${data}\x1b\\`;
    for (let row = 0; row < Math.ceil(height / this.cell.height); row++) {
      for (let column = 0; column < Math.ceil(width / this.cell.width); column++) {
        const target = this.cells[this.row + row];
        if (target && this.column + column < this.columns) target[this.column + column] = id;
      }
    }
    this.row = Math.min(this.rows - 1, this.row + Math.floor((bands - 1) * 6 / this.cell.height));
  }
}

// Every expected strip shows in full, and no other cell shows an image.
export function sixelProblems(terminal: SixelTerminal, placements: { area: { x: number; y: number; width: number; height: number }; strips: string[] }[]): string[] {
  const problems: string[] = [];
  const expected = new Map<string, string>();
  for (const { area, strips } of placements) {
    for (let row = 0; row < area.height; row++) for (let column = 0; column < area.width; column++) expected.set(`${area.y + row},${area.x + column}`, strips[row]!);
  }
  for (let row = 0; row < terminal.rows; row++) {
    for (let column = 0; column < terminal.columns; column++) {
      const want = expected.get(`${row},${column}`);
      const have = terminal.cells[row]![column];
      if (want !== have) problems.push(`${row},${column}: ${want ? "missing strip" : "stale image"}`);
    }
  }
  if (terminal.scrolls) problems.push(`screen scrolled ${terminal.scrolls} times`);
  if (terminal.wraps) problems.push(`text wrapped ${terminal.wraps} times`);
  return problems;
}
