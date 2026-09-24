import { paletteHex, type ThemeName } from "./ui/theme.ts";

// The terminal's default colors, as it reported them (OSC 10 and 11), to hand back on exit.
export type TerminalColors = { foreground?: string; background?: string };

// Windows Terminal paints its padding, and the strip left over when the window is not a
// whole number of cells, in the terminal's default background rather than any cell's
// color, so a light theme would sit in a black frame. While tuimsg runs, the default
// colors follow the theme. The foreground goes too, so that if the connection drops before
// they are restored, the shell's text stays readable on the new background.
export function themeColors(theme: ThemeName): string {
  return `\x1b]10;${spec(paletteHex("text", theme))}\x07\x1b]11;${spec(paletteHex("canvas", theme))}\x07`;
}

// The colors reported at startup, for terminals that cannot reset, then OSC 110 and 111,
// which return to the profile's own colors wherever they are supported.
export function restoreColors(original: TerminalColors): string {
  const set = (code: number, value: string | undefined) => value ? `\x1b]${code};${value}\x07` : "";
  return `${set(10, original.foreground)}${set(11, original.background)}\x1b]110\x07\x1b]111\x07`;
}

// xterm's color spec, which every terminal that takes OSC 10 and 11 reads.
function spec(hex: string): string {
  return `rgb:${hex.slice(1, 3)}/${hex.slice(3, 5)}/${hex.slice(5, 7)}`.toLowerCase();
}
