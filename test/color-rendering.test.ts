import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { Box, Text, renderToString } from "ink";
import chalk from "chalk";
import { paletteForColorLevel } from "../src/ui/theme.ts";
import { ansiCells } from "../scripts/ansi-colors.ts";

describe("terminal palette", () => {
  it.each([1, 2, 3] as const)("paints readable neutral cells at color level %i with white terminal defaults", level => {
    const previous = chalk.level;
    try {
      chalk.level = level;
      const palette = paletteForColorLevel(level);
      const output = renderToString(createElement(Box, { width: 12, height: 3, borderStyle: "round", borderColor: palette.faint, borderBackgroundColor: palette.sidebar, backgroundColor: palette.sidebar }, createElement(Text, { color: palette.text }, "BODY")));
      const cells = ansiCells(output);
      expect(cells.flat()).toHaveLength(36);
      for (const cell of cells.flat()) {
        expect(cell.background).not.toBe("#ffffff");
        expect(cell.background.slice(1, 3)).toBe(cell.background.slice(3, 5));
        expect(cell.background.slice(3, 5)).toBe(cell.background.slice(5, 7));
      }
      const body = cells.flat().find(cell => cell.character === "B");
      expect(body?.foreground).not.toBe(body?.background);
      expect(cells[0]?.[0]?.foreground).not.toBe(cells[0]?.[0]?.background);
    } finally { chalk.level = previous; }
  });

  it("avoids the RGB cube's teal approximation for dark gray panels", () => {
    const previous = chalk.level;
    try {
      chalk.level = 2;
      expect(ansiCells(chalk.bgHex("#181B21")(" "))[0]?.[0]?.background).toBe("#005f5f");
      const palette = paletteForColorLevel(2);
      const actual = ansiCells(chalk.bgHex(palette.sidebar)(" "))[0]?.[0]?.background;
      expect(actual).not.toBe("#005f5f");
      expect(actual?.slice(1, 3)).toBe(actual?.slice(3, 5));
    } finally { chalk.level = previous; }
  });
});
