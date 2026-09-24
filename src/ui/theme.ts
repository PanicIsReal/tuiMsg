import chalk from "chalk";
import { useSyncExternalStore } from "react";

// Colors are xterm-256 palette entries: truecolor terminals get their exact RGB, 256-color
// terminals (most SSH sessions) get the entry itself, so both draw the same thing. Chalk's
// own hex-to-256 rounding would shift some channels a step, washing out light mode.
// Backgrounds stay on the gray ramp, since a tinted dark gray lands on a navy or teal entry.
type Swatches = { [K in "canvas" | "sidebar" | "raised" | "rule" | "text" | "secondary" | "subtle" | "faint" | "accent" | "sms" | "failed" | "warning"]: number };
const DARK: Swatches = {
  canvas: 233, sidebar: 234, raised: 235, rule: 236, text: 254, secondary: 248, subtle: 243, faint: 239,
  accent: 75, sms: 78, failed: 210, warning: 179,
};
// Light mode darkens the accents and the quiet text to keep 4.5:1 contrast on white.
const LIGHT: Swatches = {
  canvas: 231, sidebar: 255, raised: 253, rule: 252, text: 234, secondary: 239, subtle: 242, faint: 249,
  accent: 26, sms: 28, failed: 160, warning: 130,
};

export type Palette = Record<keyof Swatches, string>;
export type ThemeName = "dark" | "light";

// The standard xterm 256-color table, from 16 on.
export function xtermHex(index: number): string {
  const level = (value: number) => value === 0 ? 0 : 55 + value * 40;
  const [red, green, blue] = index >= 232
    ? Array<number>(3).fill(8 + (index - 232) * 10)
    : [level(Math.floor((index - 16) / 36)), level(Math.floor((index - 16) / 6) % 6), level((index - 16) % 6)];
  return `#${[red!, green!, blue!].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function swatchesFor(theme: ThemeName): Swatches {
  return theme === "light" ? LIGHT : DARK;
}

function swatch(index: number, level: number): string {
  return level >= 3 ? xtermHex(index) : `ansi256(${index})`;
}

export function paletteFor(theme: ThemeName, level: number): Palette {
  if (level >= 2) {
    const swatches = swatchesFor(theme);
    return Object.fromEntries(Object.entries(swatches).map(([key, index]) => [key, swatch(index, level)])) as Palette;
  }
  // Sixteen colors hold two light grays, so the sidebar shares the canvas, as in dark mode.
  return theme === "light" ? {
    canvas: "whiteBright", sidebar: "whiteBright", raised: "white", rule: "white",
    text: "black", secondary: "blackBright", subtle: "blackBright", faint: "white",
    accent: "blue", sms: "green", failed: "red", warning: "yellow",
  } : {
    canvas: "black", sidebar: "black", raised: "black", rule: "gray",
    text: "whiteBright", secondary: "white", subtle: "gray", faint: "gray",
    accent: "blueBright", sms: "greenBright", failed: "redBright", warning: "yellow",
  };
}

// Read while rendering, so a theme switch is one re-render away: setTheme swaps the values
// in place, and components that skip re-renders (memo) call useTheme to take part.
export const colors: Palette = { ...paletteFor("dark", chalk.level) };
let current: ThemeName = "dark";
const listeners = new Set<(theme: ThemeName) => void>();

export function setTheme(theme: ThemeName): void {
  Object.assign(colors, paletteFor(theme, chalk.level));
  if (theme === current) return;
  current = theme;
  for (const listener of listeners) listener(theme);
}

export function currentTheme(): ThemeName {
  return current;
}

// The canvas as a CSS color, for filling transparent pixels in pictures.
export function canvasHex(theme: ThemeName = current): string {
  return xtermHex(swatchesFor(theme).canvas);
}

export function onThemeChange(listener: (theme: ThemeName) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTheme(): ThemeName {
  return useSyncExternalStore(onThemeChange, currentTheme, currentTheme);
}

// Group members get a steady color each, kept clear of the accent blue and the SMS green.
const PEOPLE = { dark: [173, 141, 175, 116, 186, 211], light: [166, 97, 125, 30, 58, 161] } as const;
const PEOPLE_16 = {
  dark: ["yellowBright", "magentaBright", "cyanBright", "redBright", "yellow", "magenta"],
  light: ["red", "magenta", "cyan", "yellow", "redBright", "magentaBright"],
} as const;
export function personColor(address: string, level = chalk.level): string {
  let hash = 0;
  for (const character of address) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  if (level < 2) return PEOPLE_16[current][hash % PEOPLE_16[current].length]!;
  return swatch(PEOPLE[current][hash % PEOPLE[current].length]!, level);
}

export const reactionGlyph = {
  love: "♥", like: "+1", dislike: "-1", laugh: "Ha", emphasize: "!!", question: "?",
} as const;

// A left bar drawn the full height of a box: Ink repeats `left` on every row.
export const bar = (glyph: string) => ({ topLeft: "", top: "", topRight: "", right: "", bottomRight: "", bottom: "", bottomLeft: "", left: glyph });
