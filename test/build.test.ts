import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import rememberedWidth from "../src/text-width.ts";
import { patchStyledChars } from "../scripts/build.ts";

describe("the build's shortcuts", () => {
  it("remembers widths without changing any, whatever the options", () => {
    for (const text of ["abc", "▎ Riley", "Wife 💕", "日本語", "\x1b[31mred\x1b[39m", "· … ─", "é", ""]) {
      for (const options of [undefined, { countAnsiEscapeCodes: true }, { ambiguousIsNarrow: false }]) {
        expect(rememberedWidth(text, options)).toBe(stringWidth(text, options));
        expect(rememberedWidth(text, options)).toBe(stringWidth(text, options));
      }
    }
  });

  it("patches Ink's style diff where it expects, and refuses anything else", () => {
    const ink = realpathSync(join("node_modules", "ink"));
    const source = [join(dirname(ink), "@alcalzone", "ansi-tokenize"), join("node_modules", "@alcalzone", "ansi-tokenize")]
      .map((directory) => join(directory, "build", "styledChars.js")).find((path) => existsSync(path));
    expect(source).toBeDefined();
    const patched = patchStyledChars(readFileSync(source!, "utf8"));
    expect(patched).toContain("if (!sameStyles(chars[i - 1].styles, char.styles))");
    expect(patched).toContain("function sameStyles(");
    expect(() => patchStyledChars("export function styledCharsToString() {}")).toThrow(/no longer matches/);
  });
});
