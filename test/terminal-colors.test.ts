import { describe, expect, it } from "vitest";
import { restoreColors, themeColors } from "../src/terminal-colors.ts";

describe("the terminal's default colors", () => {
  it("follow the theme's text and canvas while tuimsg runs", () => {
    expect(themeColors("light")).toBe("\x1b]10;rgb:1c/1c/1c\x07\x1b]11;rgb:ff/ff/ff\x07");
    expect(themeColors("dark")).toBe("\x1b]10;rgb:e4/e4/e4\x07\x1b]11;rgb:12/12/12\x07");
  });

  it("go back to what the terminal reported, then to the profile's own colors", () => {
    expect(restoreColors({ foreground: "rgb:cccc/cccc/cccc", background: "rgb:0c0c/0c0c/0c0c" }))
      .toBe("\x1b]10;rgb:cccc/cccc/cccc\x07\x1b]11;rgb:0c0c/0c0c/0c0c\x07\x1b]110\x07\x1b]111\x07");
    // A terminal that did not answer still gets the resets.
    expect(restoreColors({})).toBe("\x1b]110\x07\x1b]111\x07");
  });
});
