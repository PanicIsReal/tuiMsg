import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { Box, Text, render } from "ink";
import { chooseGraphics, parseProbeReplies, probeTerminal } from "../src/terminal-graphics.ts";
import { ScreenTracker } from "../src/screen-tracker.ts";

// What Windows Terminal answers (adaptDispatch.cpp: DeviceAttributes, 14 t and 16 t on its
// 10×20 sixel cell) for a 120×48 window.
const WINDOWS_TERMINAL = "\x1b[6;20;10t\x1b[4;960;1200t\x1b[?61;4;6;7;14;21;22;23;24;28;32;42c";
const grid = { columns: 120, rows: 48 };

describe("choosing how to draw pictures", () => {
  it("uses sixel on Windows Terminal, with its cell size", () => {
    expect(parseProbeReplies(WINDOWS_TERMINAL)).toEqual({ attributes: [61, 4, 6, 7, 14, 21, 22, 23, 24, 28, 32, 42], cell: { width: 10, height: 20 }, textArea: { width: 1200, height: 960 } });
    expect(chooseGraphics({ TERM: "xterm-256color" }, parseProbeReplies(WINDOWS_TERMINAL), grid)).toEqual({ protocol: "sixel", cell: { width: 10, height: 20 } });
  });

  it("reads replies whose ESC a Windows Terminal 1.22 preview dropped", () => {
    expect(chooseGraphics({}, parseProbeReplies(WINDOWS_TERMINAL.replaceAll("\x1b", "")), grid)).toEqual({ protocol: "sixel", cell: { width: 10, height: 20 } });
  });

  it("derives the cell from the text area when only that is reported", () => {
    expect(chooseGraphics({}, parseProbeReplies("\x1b[4;816;1080t\x1b[?62;4c"), grid)).toEqual({ protocol: "sixel", cell: { width: 9, height: 17 } });
  });

  it("falls back to blocks without sixel support or without a cell size", () => {
    expect(chooseGraphics({}, parseProbeReplies("\x1b[6;20;10t\x1b[?62;22c"), grid).protocol).toBe("blocks");
    expect(chooseGraphics({}, parseProbeReplies("\x1b[?62;4;22c"), grid).protocol).toBe("blocks");
    expect(chooseGraphics({}, {}, grid).protocol).toBe("blocks");
  });

  it("prefers kitty graphics where the environment names a kitty terminal, outside tmux", () => {
    expect(chooseGraphics({ TERM: "xterm-kitty" }, parseProbeReplies(WINDOWS_TERMINAL), grid).protocol).toBe("kitty");
    expect(chooseGraphics({ TERM: "xterm-ghostty" }, {}, grid).protocol).toBe("kitty");
    expect(chooseGraphics({ TERM: "xterm-kitty", TMUX: "/tmp/tmux" }, parseProbeReplies(WINDOWS_TERMINAL), grid).protocol).toBe("sixel");
  });

  it("honors TUIMSG_IMAGES", () => {
    expect(chooseGraphics({ TUIMSG_IMAGES: "blocks" }, parseProbeReplies(WINDOWS_TERMINAL), grid).protocol).toBe("blocks");
    expect(chooseGraphics({ TUIMSG_IMAGES: "sixel" }, {}, grid)).toEqual({ protocol: "sixel", cell: { width: 10, height: 20 } });
    expect(chooseGraphics({ TUIMSG_IMAGES: "SIXEL", TERM: "xterm-kitty" }, {}, grid).protocol).toBe("sixel");
    expect(chooseGraphics({ TUIMSG_IMAGES: "kitty" }, {}, grid).protocol).toBe("kitty");
  });
});

function fakeTerminal(answer: (query: string, input: PassThrough) => void) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, modes: [] as boolean[] }) as PassThrough & { isTTY: boolean; isRaw: boolean; modes: boolean[]; setRawMode: (mode: boolean) => void };
  input.setRawMode = (mode: boolean) => { input.isRaw = mode; input.modes.push(mode); };
  const written: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 120, rows: 48,
    write(text: string) { written.push(text); answer(text, input); return true; },
  });
  return { input, output, written };
}

describe("probing the terminal", () => {
  it("reads the replies in raw mode, returns keys typed meanwhile, and restores the mode", async () => {
    const { input, output, written } = fakeTerminal((_, stream) => setTimeout(() => stream.write(`q${WINDOWS_TERMINAL}`), 5));
    const started = Date.now();
    const replies = await probeTerminal(input as never, output as never, 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(written).toEqual(["\x1b[16t\x1b[14t\x1b[c"]);
    expect(replies.cell).toEqual({ width: 10, height: 20 });
    expect(replies.attributes).toContain(4);
    expect(input.modes).toEqual([true, false]);
    expect(String(input.read())).toBe("q");
  });

  it("does not hand ESC-less replies to the app as typed keys", async () => {
    const { input, output } = fakeTerminal((_, stream) => setTimeout(() => stream.write(WINDOWS_TERMINAL.replaceAll("\x1b", "")), 5));
    const replies = await probeTerminal(input as never, output as never, 5_000);
    expect(replies.cell).toEqual({ width: 10, height: 20 });
    expect(input.read()).toBeNull();
  });

  it("gives up on a silent terminal", async () => {
    const { input, output } = fakeTerminal(() => undefined);
    expect(await probeTerminal(input as never, output as never, 30)).toEqual({});
    expect(input.isRaw).toBe(false);
  });
});

class InkTerminal extends EventEmitter {
  isTTY = true;
  columns = 30;
  rows = 6;
  writes: string[] = [];
  write(text: string) { this.writes.push(text); return true; }
}

describe("following Ink's output", () => {
  it("reports the rows each incremental frame rewrites", async () => {
    const out = new InkTerminal();
    const tracker = new ScreenTracker(() => out.rows);
    const frame = (changed: string) => createElement(Box, { flexDirection: "column", height: 6 },
      createElement(Text, {}, "header"), createElement(Text, {}, "left │ picture"), createElement(Text, {}, `left │ ${changed}`),
      createElement(Text, {}, "left │ picture"), createElement(Text, {}, "left │ below"), createElement(Text, {}, "footer"));
    const app = render(frame("first"), { stdout: out as never, stdin: new PassThrough() as never, interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(tracker.feed(out.writes.splice(0).join("")).all).toBe(true);
      app.rerender(frame("second"));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const damage = tracker.feed(out.writes.splice(0).join(""));
      expect(damage.all).toBe(false);
      expect([...damage.rows]).toEqual([2]);
    } finally { app.unmount(); }
  });

  it("follows absolute moves, saved cursors, erases, and skips string payloads", () => {
    const tracker = new ScreenTracker(() => 10);
    expect([...tracker.feed("\x1b[4;1Hx\x1b7\x1b[9;1H\x1bP0;1;0q#1!9~\x1b\\\x1b]0;title\x07\x1b8y").rows]).toEqual([3]);
    expect([...tracker.feed("\x1b[2;5H\x1b[K\x1b[B\x1b[2K").rows]).toEqual([1, 2]);
    expect([...tracker.feed("\x1b[8;1H\x1b[J").rows]).toEqual([7, 8, 9]);
    expect(tracker.feed("\x1b[2J").all).toBe(true);
    // Split across writes, a sequence still parses.
    tracker.feed("\x1b[");
    expect([...tracker.feed("6;1Hz").rows]).toEqual([5]);
  });
});
