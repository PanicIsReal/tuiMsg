import { describe, expect, it } from "vitest";
import { isMouseSequence, parseMouseEvent } from "../../src/ui/mouse.tsx";

describe("terminal mouse protocol", () => {
  it("parses SGR clicks and wheels as zero-based coordinates", () => {
    expect(parseMouseEvent("\x1b[<0;12;4M")).toEqual({ kind: "click", button: "left", x: 11, y: 3 });
    expect(parseMouseEvent("[<0;12;4M")).toEqual({ kind: "click", button: "left", x: 11, y: 3 });
    expect(parseMouseEvent("\x1b[<65;12;4M")).toEqual({ kind: "wheel", direction: "down", x: 11, y: 3 });
    expect(parseMouseEvent("\x1b[<0;12;4m")).toBeUndefined();
  });

  it("recognizes incomplete mouse sequences so text inputs can consume them", () => {
    expect(isMouseSequence("\x1b[<0;12;")).toBe(true);
    expect(isMouseSequence("[<0;12;")).toBe(true);
    expect(isMouseSequence("hello")).toBe(false);
  });

  it("rejects coordinates outside a complete protocol event", () => {
    expect(parseMouseEvent("\x1b[<0;12M")).toBeUndefined();
  });
});
