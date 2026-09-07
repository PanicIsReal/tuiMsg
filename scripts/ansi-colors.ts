export type AnsiCell = { character: string; foreground: string; background: string };
const basic = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];
export function indexedColor(index: number): string {
  if (index < 16) return basic[index] ?? "#000000";
  if (index >= 232) return rgb(8 + (index - 232) * 10, 8 + (index - 232) * 10, 8 + (index - 232) * 10);
  const value = index - 16;
  const cube = [0, 95, 135, 175, 215, 255];
  return rgb(cube[Math.floor(value / 36)] ?? 0, cube[Math.floor(value / 6) % 6] ?? 0, cube[value % 6] ?? 0);
}
function rgb(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}
export function ansiCells(ansi: string, defaults = { foreground: "#000000", background: "#ffffff" }): AnsiCell[][] {
  let foreground = defaults.foreground;
  let background = defaults.background;
  const lines: AnsiCell[][] = [[]];
  for (const token of ansi.matchAll(/\x1b\[([\d;]*)m|([^\x1b])/gu)) {
    if (token[1] !== undefined) {
      const codes = token[1].split(";").map(Number);
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index] ?? 0;
        if (code === 0) { foreground = defaults.foreground; background = defaults.background; }
        else if (code === 39) foreground = defaults.foreground;
        else if (code === 49) background = defaults.background;
        else if (code >= 30 && code <= 37) foreground = indexedColor(code - 30);
        else if (code >= 90 && code <= 97) foreground = indexedColor(code - 90 + 8);
        else if (code >= 40 && code <= 47) background = indexedColor(code - 40);
        else if (code >= 100 && code <= 107) background = indexedColor(code - 100 + 8);
        else if (code === 38 || code === 48) {
          const mode = codes[++index];
          let color: string | undefined;
          if (mode === 5) color = indexedColor(codes[++index] ?? 0);
          else if (mode === 2) color = rgb(codes[++index] ?? 0, codes[++index] ?? 0, codes[++index] ?? 0);
          if (color) { if (code === 38) foreground = color; else background = color; }
        }
      }
    } else if (token[2] === "\n") lines.push([]);
    else if (token[2] && token[2] !== "\r") lines.at(-1)?.push({ character: token[2], foreground, background });
  }
  return lines;
}
export function ansiSvg(ansi: string, columns: number, lightDefault: boolean): string {
  const defaults = lightDefault ? { foreground: "#000000", background: "#ffffff" } : { foreground: "#eeeeee", background: "#000000" };
  const lines = ansiCells(ansi, defaults);
  const escape = (text: string) => text.replace(/[&<>\"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
  const pieces = [`<svg xmlns="http://www.w3.org/2000/svg" width="${columns * 9}" height="${lines.length * 18}"><rect width="100%" height="100%" fill="${defaults.background}"/>`];
  for (const [y, line] of lines.entries()) for (const [x, cell] of line.entries()) {
    pieces.push(`<rect x="${x * 9}" y="${y * 18}" width="9" height="18" fill="${cell.background}"/>`);
    if (cell.character !== " ") pieces.push(`<text x="${x * 9}" y="${y * 18 + 14}" font-family="Menlo, monospace" font-size="14" fill="${cell.foreground}">${escape(cell.character)}</text>`);
  }
  return `${pieces.join("")}</svg>`;
}
