import { describe, expect, it } from "vitest";
import { osc52Sequence, writeClipboard } from "../src/clipboard.ts";

const BODY = "You coming tonight?";

describe("osc52Sequence", () => {
  it("emits OSC 52 with base64 payload", () => {
    const seq = osc52Sequence(BODY, false);
    expect(seq.startsWith("\x1b]52;c;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
    expect(seq).toContain(Buffer.from(BODY, "utf8").toString("base64"));
  });

  it("wraps tmux DCS", () => {
    const seq = osc52Sequence(BODY, true);
    expect(seq.startsWith("\x1bPtmux;\x1b")).toBe(true);
    expect(seq.endsWith("\x1b\\")).toBe(true);
    expect(seq).toContain(Buffer.from(BODY, "utf8").toString("base64"));
  });
});

describe("writeClipboard", () => {
  it("writes the shipped OSC 52 sequence to stdout", () => {
    const chunks: string[] = [];
    const stdout = {
      write(s: string | Uint8Array) {
        chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
        return true;
      },
    } as NodeJS.WritableStream;
    const prev = process.env.TMUX;
    delete process.env.TMUX;
    try {
      writeClipboard(BODY, stdout);
    } finally {
      if (prev === undefined) delete process.env.TMUX;
      else process.env.TMUX = prev;
    }
    expect(chunks.join("")).toBe(osc52Sequence(BODY, false));
  });
});
