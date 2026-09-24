import { noDamage, type Damage } from "./frame-diff.ts";

// Follows the cursor through output other than Ink's frames (those are diffed cell by cell)
// to learn which screen rows each write touched. Sixel pixels live in the terminal's cells,
// and a terminal drops them wherever text is written or erased, so an image under a
// rewritten row has to be drawn again. Such writes are rare, so whole rows are enough.
export type { Damage };

type State = "ground" | "escape" | "escape-intermediate" | "csi" | "string" | "string-escape";

export class ScreenTracker {
  private row = 0;
  private saved = 0;
  private state: State = "ground";
  private params = "";
  // OSC strings may end with BEL; DCS, APC, PM and SOS only with ST.
  private bellEnds = false;
  private damage: Damage = noDamage();

  constructor(private readonly height: () => number) {}

  // Returns the rows touched since the previous call.
  feed(text: string): Damage {
    for (let index = 0; index < text.length; index++) this.step(text.charCodeAt(index));
    const damage = this.damage;
    this.damage = noDamage();
    return damage;
  }

  private step(code: number): void {
    switch (this.state) {
      case "ground":
        if (code === 0x1b) this.state = "escape";
        else if (code === 0x0a || code === 0x0b || code === 0x0c) this.lineFeed();
        else if (code >= 0x20 && code !== 0x7f) this.touch(this.row);
        return;
      case "escape":
        this.state = "ground";
        if (code === 0x5b) { this.state = "csi"; this.params = ""; }
        else if (code === 0x5d) { this.state = "string"; this.bellEnds = true; }
        else if (code === 0x50 || code === 0x5f || code === 0x5e || code === 0x58) { this.state = "string"; this.bellEnds = false; }
        else if (code >= 0x20 && code <= 0x2f) this.state = "escape-intermediate";
        else if (code === 0x37) this.saved = this.row;
        else if (code === 0x38) this.row = this.saved;
        else if (code === 0x44) this.lineFeed();
        else if (code === 0x45) this.lineFeed();
        else if (code === 0x4d) { if (this.row === 0) this.damage.all = true; else this.row -= 1; }
        else if (code === 0x63) { this.row = 0; this.damage.all = true; }
        return;
      case "escape-intermediate":
        if (code < 0x20 || code > 0x2f) this.state = "ground";
        return;
      case "csi":
        if (code >= 0x40 && code <= 0x7e) { this.state = "ground"; this.csi(String.fromCharCode(code)); }
        else if (code === 0x1b) this.state = "escape";
        else this.params += String.fromCharCode(code);
        return;
      case "string":
        if (code === 0x1b) this.state = "string-escape";
        else if (code === 0x07 && this.bellEnds) this.state = "ground";
        return;
      case "string-escape":
        this.state = code === 0x5c ? "ground" : "string";
        return;
    }
  }

  private csi(final: string): void {
    const privateMarker = /^[<=>?]/.test(this.params);
    const values = (privateMarker ? this.params.slice(1) : this.params).split(";").map((value) => Number.parseInt(value, 10));
    const first = Number.isFinite(values[0]) ? values[0]! : 0;
    const count = Math.max(1, first);
    const last = this.height() - 1;
    if (privateMarker) {
      // Switching screens (1049, 1047, 47) replaces everything on it.
      if ((final === "h" || final === "l") && values.some((value) => value === 1049 || value === 1047 || value === 47)) this.damage.all = true;
      return;
    }
    switch (final) {
      case "A": this.row = Math.max(0, this.row - count); break;
      case "B": case "e": this.row = Math.min(last, this.row + count); break;
      case "E": this.row = Math.min(last, this.row + count); break;
      case "F": this.row = Math.max(0, this.row - count); break;
      case "H": case "f": this.row = Math.min(last, Math.max(0, count - 1)); break;
      case "d": this.row = Math.min(last, Math.max(0, count - 1)); break;
      case "K": case "X": case "P": case "@": this.touch(this.row); break;
      case "J":
        if (first === 0) this.touchFrom(this.row);
        else if (first === 1) for (let row = 0; row <= this.row; row++) this.touch(row);
        else this.damage.all = true;
        break;
      case "L": case "M": this.touchFrom(this.row); break;
      case "S": case "T": this.damage.all = true; break;
      case "r": this.row = 0; break;
      case "s": if (!this.params) this.saved = this.row; break;
      case "u": if (!this.params) this.row = this.saved; break;
    }
  }

  private lineFeed(): void {
    // Output processing turns LF into CR LF; at the bottom it scrolls the whole screen.
    if (this.row >= this.height() - 1) this.damage.all = true;
    else this.row += 1;
  }

  private touch(row: number): void {
    this.damage.rows.add(row);
  }

  private touchFrom(row: number): void {
    for (let current = row; current < this.height(); current++) this.touch(current);
  }
}
