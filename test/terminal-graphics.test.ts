import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { Box, Text, render } from "ink";
import { chooseGraphics, detectTerminal, parseProbeReplies, probeTerminal } from "../src/terminal-graphics.ts";
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

describe("telling a light terminal from a dark one", () => {
  it("weighs the OSC 11 background color, whatever its channel width or terminator", () => {
    expect(parseProbeReplies("\x1b]11;rgb:ffff/ffff/ffff\x1b\\").background).toBe("light");
    expect(parseProbeReplies("\x1b]11;rgb:0c0c/0c0c/0c0c\x07").background).toBe("dark");
    expect(parseProbeReplies("\x1b]11;rgb:fd/f6/e3\x07").background).toBe("light");
    expect(parseProbeReplies("\x1b]11;rgba:0000/2b2b/3636/ffff\x07").background).toBe("dark");
    // Saturated blue is dark to the eye even with one channel at full.
    expect(parseProbeReplies("\x1b]11;rgb:0000/0000/ffff\x07").background).toBe("dark");
    expect(parseProbeReplies("]11;rgb:ffff/ffff/ffff\\").background).toBe("light");
    expect(parseProbeReplies("\x1b]11;#fff\x07").background).toBe("light");
    expect(parseProbeReplies("\x1b]11;#1e1e1e\x07").background).toBe("dark");
    expect(parseProbeReplies(WINDOWS_TERMINAL).background).toBeUndefined();
  });

  it("keeps the reported colors to hand back, in the terminal's own notation", () => {
    expect(parseProbeReplies(`\x1b]10;rgb:cccc/cccc/cccc\x1b\\\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\${WINDOWS_TERMINAL}`).colors)
      .toEqual({ foreground: "rgb:cccc/cccc/cccc", background: "rgb:0c0c/0c0c/0c0c" });
    expect(parseProbeReplies("]10;#ccc\x07]11;#0c0c0c\x07").colors).toEqual({ foreground: "#ccc", background: "#0c0c0c" });
    // Nothing else is echoed back into the terminal.
    expect(parseProbeReplies("\x1b]11;rgb:00/00/00;\x1b[2J\x07").colors).toBeUndefined();
    expect(parseProbeReplies("\x1b]11;black\x07").colors).toBeUndefined();
  });
});

describe("probing the terminal", () => {
  it("reads the replies in raw mode, returns keys typed meanwhile, and restores the mode", async () => {
    const { input, output, written } = fakeTerminal((_, stream) => setTimeout(() => stream.write(`q${WINDOWS_TERMINAL}`), 5));
    const started = Date.now();
    const replies = await probeTerminal(input as never, output as never, 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(written).toEqual(["\x1b]10;?\x07\x1b]11;?\x07\x1b[16t\x1b[14t\x1b[c"]);
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

  it("reads the default colors and keeps their replies out of typed keys", async () => {
    const colors = "\x1b]10;rgb:0000/0000/0000\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\";
    const { input, output } = fakeTerminal((_, stream) => setTimeout(() => stream.write(`${colors}${WINDOWS_TERMINAL}j`), 5));
    const replies = await probeTerminal(input as never, output as never, 5_000);
    expect(replies.background).toBe("light");
    expect(replies.colors).toEqual({ foreground: "rgb:0000/0000/0000", background: "rgb:ffff/ffff/ffff" });
    expect(replies.cell).toEqual({ width: 10, height: 20 });
    expect(String(input.read())).toBe("j");
  });

  it.each([
    ["without its ESC", "]10;rgb:cccc/cccc/cccc\\]11;rgb:1e1e/1e1e/1e1e\\"],
    ["in a format it does not read", "\x1b]10;white\x07\x1b]11;black\x07"],
  ])("drops color replies %s", async (_, reply) => {
    const { input, output } = fakeTerminal((_, stream) => setTimeout(() => stream.write(`${reply}${WINDOWS_TERMINAL}`), 5));
    await probeTerminal(input as never, output as never, 5_000);
    expect(input.read()).toBeNull();
  });

  it("probes even where pictures need no answer, for the theme and the colors to restore", async () => {
    const { input, output, written } = fakeTerminal((_, stream) => setTimeout(() => stream.write("\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?62;22c"), 5));
    expect(await detectTerminal(input as never, output as never, { TUIMSG_IMAGES: "blocks" }))
      .toEqual({ graphics: { protocol: "blocks", cell: { width: 10, height: 20 } }, colors: { background: "rgb:ffff/ffff/ffff" }, background: "light" });
    expect(written).toHaveLength(1);
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
