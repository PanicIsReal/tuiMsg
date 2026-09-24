import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import rememberedWidth from "../src/text-width.ts";
import { patchOutput, patchStyledChars } from "../scripts/build.ts";

type Operation = { write: [number, number, string] } | { clip: { x1: number; x2: number; y1: number; y2: number } } | "unclip";
type OutputClass = new (size: { width: number; height: number }) => {
  write(x: number, y: number, text: string, options: { transformers: [] }): void;
  clip(clip: object): void; unclip(): void; get(): { output: string; height: number };
};

// Ink's Output class from its source, stock or patched, with Ink's own dependencies.
async function outputClass(source: string): Promise<OutputClass> {
  const modules = dirname(realpathSync(join("node_modules", "ink")));
  const load = (path: string) => import(pathToFileURL(join(modules, path)).href);
  const [{ default: sliceAnsi }, { default: width }, tokenizer] = await Promise.all([
    load("slice-ansi/index.js"), load("string-width/index.js"), load("@alcalzone/ansi-tokenize/build/index.js"),
  ]);
  const body = source.replace(/^import .*$/gm, "").replace("export default class Output", "return class Output");
  return new Function("sliceAnsi", "stringWidth", "styledCharsFromTokens", "styledCharsToString", "tokenize", body)(
    sliceAnsi, width, tokenizer.styledCharsFromTokens, tokenizer.styledCharsToString, tokenizer.tokenize) as OutputClass;
}

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

  it("keeps Ink's line caches across frames without changing a frame", async () => {
    const path = join(realpathSync(join("node_modules", "ink")), "build", "output.js");
    const source = readFileSync(path, "utf8");
    const patched = patchOutput(source);
    expect(patched).toContain("caches = sharedCaches;");
    expect(patched).toContain("return this.caches.getSlice(line, from, to);");
    expect(() => patchOutput("export default class Output {}")).toThrow(/no longer matches/);
    const [Stock, Patched] = await Promise.all([outputClass(source), outputClass(patched)]);
    const red = (text: string) => `\x1b[31m${text}\x1b[39m`;
    const blocks = Array.from({ length: 12 }, (_, index) => `\x1b[38;5;${index}m\x1b[48;5;${200 + index}m▄`).join("") + "\x1b[0m";
    // Each frame clips a line of blocks at both ends, where it moves the same line is cut
    // at other points, and clips a coloured line at one end.
    const frame = (time: string, indent: number): Operation[] => [
      { write: [0, 0, "Messages"] }, { clip: { x1: 4, x2: 10, y1: 1, y2: 3 } }, { write: [2, 1, red(`Riley · ${time}`)] }, { write: [2 + indent, 2, blocks] }, "unclip",
      { write: [indent, 3, "日本語 and 💕 wide"] },
    ];
    const frames = [frame("8:39", 0), frame("8:40", 1), frame("8:39", 0)];
    // A new Output for every frame, as Ink makes; the patched ones share what they parsed.
    for (const frame of [...frames, ...frames]) {
      const [stock, shared] = [new Stock({ width: 24, height: 4 }), new Patched({ width: 24, height: 4 })];
      for (const output of [stock, shared]) {
        for (const operation of frame) {
          if (operation === "unclip") output.unclip();
          else if ("clip" in operation) output.clip(operation.clip);
          else output.write(...operation.write, { transformers: [] });
        }
      }
      expect(shared.get()).toEqual(stock.get());
    }
  });
});
