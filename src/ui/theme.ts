import chalk from "chalk";

// Backgrounds stay pure grays: over SSH most terminals get 256 colors, where a tinted dark
// gray lands on a navy or teal cube color. Every value is an exact xterm-256 color, so
// truecolor and 256-color terminals draw the same thing.
const palette = {
  canvas: "#121212", sidebar: "#1C1C1C", raised: "#262626", rule: "#303030",
  text: "#E4E4E4", secondary: "#A8A8A8", subtle: "#767676", faint: "#4E4E4E",
  accent: "#5FAFFF", sms: "#5FD787", failed: "#FF8787", warning: "#D7AF5F",
} as const;

export type Palette = Record<keyof typeof palette, string>;

export function paletteForColorLevel(level: number): Palette {
  if (level >= 2) return palette;
  return {
    canvas: "black", sidebar: "black", raised: "black", rule: "gray",
    text: "whiteBright", secondary: "white", subtle: "gray", faint: "gray",
    accent: "blueBright", sms: "greenBright", failed: "redBright", warning: "yellow",
  };
}

export const colors = paletteForColorLevel(chalk.level);

// Group members get a steady color each, kept clear of the blue for you and green for SMS.
const PEOPLE_256 = ["#D7875F", "#AF87FF", "#D787AF", "#87D7D7", "#D7D787", "#FF87AF"] as const;
const PEOPLE_16 = ["yellowBright", "magentaBright", "cyanBright", "redBright", "yellow", "magenta"] as const;
export function personColor(address: string, level = chalk.level): string {
  let hash = 0;
  for (const character of address) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  const people = level >= 2 ? PEOPLE_256 : PEOPLE_16;
  return people[hash % people.length]!;
}

export const reactionGlyph = {
  love: "♥", like: "+1", dislike: "-1", laugh: "Ha", emphasize: "!!", question: "?",
} as const;

// A left bar drawn the full height of a box: Ink repeats `left` on every row.
export const bar = (glyph: string) => ({ topLeft: "", top: "", topRight: "", right: "", bottomRight: "", bottom: "", bottomLeft: "", left: glyph });
