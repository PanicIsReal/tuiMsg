import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { Box, Text, renderToString } from "ink";
import chalk from "chalk";
import { paletteFor, type Palette, type ThemeName } from "../src/ui/theme.ts";
import { ansiCells } from "../scripts/ansi-colors.ts";

// Terminal defaults no palette entry uses, so a cell left unpainted stands out in either theme.
const UNPAINTED = { foreground: "#010203", background: "#fefdfc" };

function withLevel<T>(level: 0 | 1 | 2 | 3, body: () => T): T {
  const previous = chalk.level;
  try {
    chalk.level = level;
    return body();
  } finally { chalk.level = previous; }
}

function paint(color: string, level: 0 | 1 | 2 | 3): { foreground: string; background: string } {
  return withLevel(level, () => {
    const cell = ansiCells(renderToString(createElement(Box, { width: 1, height: 1, backgroundColor: color }, createElement(Text, { color }, "x"))), UNPAINTED)[0]?.[0];
    return { foreground: cell?.foreground ?? "", background: cell?.background ?? "" };
  });
}

// WCAG relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const themes = ["dark", "light"] as const satisfies readonly ThemeName[];

describe("terminal palette", () => {
  it.each(themes.flatMap((theme) => ([1, 2, 3] as const).map((level) => [theme, level] as const)))("paints every cell of a %s panel a neutral gray at color level %i", (theme, level) => {
    withLevel(level, () => {
      const palette = paletteFor(theme, level);
      const output = renderToString(createElement(Box, { width: 12, height: 3, borderStyle: "round", borderColor: palette.faint, borderBackgroundColor: palette.sidebar, backgroundColor: palette.sidebar }, createElement(Text, { color: palette.text }, "BODY")));
      const cells = ansiCells(output, UNPAINTED);
      expect(cells.flat()).toHaveLength(36);
      for (const cell of cells.flat()) {
        expect(cell.background).not.toBe(UNPAINTED.background);
        expect(cell.background.slice(1, 3)).toBe(cell.background.slice(3, 5));
        expect(cell.background.slice(3, 5)).toBe(cell.background.slice(5, 7));
      }
      const body = cells.flat().find(cell => cell.character === "B");
      expect(body?.foreground).not.toBe(body?.background);
      expect(cells[0]?.[0]?.foreground).not.toBe(cells[0]?.[0]?.background);
    });
  });

  it.each(themes)("draws the %s theme identically in 256 colors and truecolor", (theme) => {
    // Chalk's own rounding would turn this dark gray into a teal cube entry over SSH.
    expect(withLevel(2, () => ansiCells(chalk.bgHex("#181B21")(" "))[0]?.[0]?.background)).toBe("#005f5f");
    const indexed = paletteFor(theme, 2);
    const truecolor = paletteFor(theme, 3);
    for (const key of Object.keys(indexed) as (keyof Palette)[]) {
      expect(indexed[key]).toMatch(/^ansi256\(\d+\)$/);
      expect(paint(indexed[key], 2), key).toEqual(paint(truecolor[key], 3));
    }
  });

  it.each(themes)("keeps %s text readable on its backgrounds", (theme) => {
    const palette = paletteFor(theme, 3);
    for (const background of [palette.canvas, palette.sidebar]) {
      expect(contrast(palette.text, background)).toBeGreaterThan(12);
      expect(contrast(palette.secondary, background)).toBeGreaterThan(6);
    }
    // Links, SMS tags, and errors sit on the canvas.
    for (const color of [palette.accent, palette.sms, palette.failed, palette.warning]) expect(contrast(color, palette.canvas)).toBeGreaterThanOrEqual(4.5);
    // Quiet text still clears 4.5:1 where light mode puts it; the approved dark look is kept.
    expect(contrast(palette.subtle, palette.canvas)).toBeGreaterThanOrEqual(theme === "light" ? 4.5 : 4);
    // Bars and rules show against the canvas without competing with text.
    expect(contrast(palette.faint, palette.canvas)).toBeGreaterThan(1.8);
    expect(contrast(palette.faint, palette.canvas)).toBeLessThan(contrast(palette.subtle, palette.canvas));
  });
});
