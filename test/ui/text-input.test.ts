import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { stripVTControlCharacters } from "node:util";
import { Box } from "ink";
import { inputLines, inputRowCount, verticalMove } from "../../src/ui/TextInput.tsx";
import { Composer, composerHeight } from "../../src/ui/Composer.tsx";

const rows = (value: string, width: number) => inputLines(Array.from(value), -1, width).lines.map((line) => line.map((cell) => cell.text).join(""));

describe("input wrapping", () => {
  it("wraps at the width and keeps a cell at the end for the caret", () => {
    expect(rows("abcdefgh", 3)).toEqual(["abc", "def", "gh "]);
    expect(inputRowCount("", 10)).toBe(1);
    expect(inputRowCount("abcdefghi", 10)).toBe(1);
    // A full row pushes the caret onto a row of its own.
    expect(inputRowCount("abcdefghij", 10)).toBe(2);
    expect(inputRowCount("ab\ncd", 10)).toBe(2);
    // A wide character never splits across rows.
    expect(rows("ab中", 3)).toEqual(["ab", "中 "]);
  });
});

describe("moving up and down", () => {
  const text = Array.from("abcdefgh\nxy");
  it("keeps the column across wrapped rows", () => {
    // Rows at width 3: abc / def / gh⏎ / xy_
    expect(verticalMove(text, 7, 3, -1)).toBe(4);
    expect(verticalMove(text, 4, 3, -1)).toBe(1);
    expect(verticalMove(text, 1, 3, 1)).toBe(4);
  });

  it("stops at the end of a shorter row", () => {
    // From "f" (column 2) down to "gh⏎": the newline is the end of that line.
    expect(verticalMove(text, 5, 3, 1)).toBe(8);
    // From the newline down to "xy", past its last letter: the caret after it.
    expect(verticalMove(text, 8, 3, 1)).toBe(11);
  });

  it("stays put on the first and last rows", () => {
    expect(verticalMove(text, 1, 3, -1)).toBe(1);
    expect(verticalMove(text, 10, 3, 1)).toBe(10);
  });
});

describe("composer height", () => {
  const draft = (text: string) => ({ text, replyTo: null });
  it("grows as the draft wraps, up to its limit", () => {
    // A 40-cell lane leaves 34 cells for the input.
    expect(composerHeight(draft("x".repeat(33)), true, 40, 5)).toBe(2);
    expect(composerHeight(draft("x".repeat(80)), true, 40, 5)).toBe(4);
    expect(composerHeight(draft("x".repeat(1000)), true, 40, 5)).toBe(6);
    // Unfocused, it shows one line whatever the draft.
    expect(composerHeight(draft("x".repeat(80)), false, 40, 5)).toBe(2);
  });

  it("shows every row of a wrapped draft", () => {
    const text = "The quick brown fox jumps over the lazy dog, then naps in the afternoon sun.";
    const composer = createElement(Composer, {
      draft: draft(text), service: "iMessage", focused: true, width: 40, maxRows: 10,
      onChange: () => undefined, onSubmit: () => undefined, onEscape: () => undefined,
    });
    const app = render(createElement(Box, { width: 40, flexDirection: "column" }, composer));
    const lines = stripVTControlCharacters(app.lastFrame() ?? "").split("\n");
    app.unmount();
    // A rule, then the prompt and three rows of 34 cells, none clipped or wrapped twice.
    expect(lines).toHaveLength(4);
    expect(lines.slice(1).map((line) => line.slice(4).trimEnd()).join("")).toBe(text);
  });
});
