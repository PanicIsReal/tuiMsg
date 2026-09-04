import { describe, expect, it } from "vitest";
import { osc52Sequence } from "../src/clipboard.ts";

describe("osc52Sequence", () => {
  it("emits OSC 52 with base64 payload", () => {
    const seq = osc52Sequence("hi", false);
    expect(seq.startsWith("\x1b]52;c;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
    expect(seq).toContain(Buffer.from("hi").toString("base64"));
  });

  it("wraps tmux DCS", () => {
    const seq = osc52Sequence("hi", true);
    expect(seq.startsWith("\x1bPtmux;\x1b")).toBe(true);
    expect(seq.endsWith("\x1b\\")).toBe(true);
  });
});
