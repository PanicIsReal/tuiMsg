import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { FrameDiff, frameText, parseLine } from "../src/frame-diff.ts";
import { TextTerminal } from "./support/text-terminal.ts";

const BG = "\x1b[48;5;233m";
const line = (text: string, width: number, style = BG) => `${style}${text}${" ".repeat(Math.max(0, width - stringWidth(text)))}\x1b[49m`;

// The screen a terminal shows when a frame is drawn whole, line by line, from blank.
function drawn(frame: string, columns: number, rows: number): string[] {
  const terminal = new TextTerminal(columns, rows);
  frame.split("\n").forEach((text, index) => terminal.feed(`\x1b[${index + 1};1H${text}\x1b[0m`));
  return terminal.snapshot();
}

function play(frames: string[], columns = 30, rows = 5) {
  const diff = new FrameDiff();
  const terminal = new TextTerminal(columns, rows);
  const sizes: number[] = [];
  const touched: number[][] = [];
  for (const frame of frames) {
    const result = diff.render(frame, columns, rows)!;
    terminal.feed(result.output);
    sizes.push(Buffer.byteLength(result.output));
    touched.push([...result.damage.spans.keys()]);
    expect(terminal.snapshot(), JSON.stringify(frame)).toEqual(drawn(frame, columns, rows));
  }
  expect(terminal.wraps).toBe(0);
  return { sizes, touched, terminal };
}

describe("drawing frames by the cells that changed", () => {
  it("leaves the same screen as drawing every frame whole", () => {
    const base = ["Messages", "  Riley       8:39 AM", "  Jeremy      8:37 AM", "", "online"];
    const frames = [
      base.map((text) => line(text, 30)).join("\n"),
      base.map((text, index) => line(text, 30, index === 1 ? "\x1b[48;5;235m\x1b[1m" : BG)).join("\n"),
      base.map((text, index) => line(text, 30, index === 2 ? "\x1b[48;5;235m\x1b[1m" : BG)).join("\n"),
      // Shorter lines, fewer lines, and a line with no background at all.
      ["\x1b[1mMessages\x1b[22m", line("  Riley", 30)].join("\n"),
      ["plain text", "", line("back again", 30)].join("\n"),
    ];
    const { sizes, touched } = play(frames);
    // Moving the highlight rewrites the two rows it left and entered, nothing else.
    expect(touched[2]).toEqual([1, 2]);
    expect(sizes[2]!).toBeLessThan(sizes[0]!);
  });

  it("keeps wide characters whole and hyperlinks attached", () => {
    const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
    play([
      [line("Wife 💕  hi", 20), line(`see ${link("https://a.test", "a.test")} ok`, 20)].join("\n"),
      [line("Wife xx  hi", 20), line(`see ${link("https://b.test", "a.test")} ok`, 20)].join("\n"),
      [line("W💕fe 💕 hi", 20), `\x1b]8;;https://c.test\x07see a.test\x1b]8;;\x07`].join("\n"),
      [line("日本語のテキスト", 20), line("", 20)].join("\n"),
      [line("日本 text", 20), line("x", 20)].join("\n"),
    ], 20, 2);
  });

  it("treats different ways of writing one style as the same style", () => {
    expect(parseLine("\x1b[1m\x1b[38;5;254mA\x1b[39m\x1b[22m").style[0]).toBe(parseLine("\x1b[38;5;254;1mA\x1b[0m").style[0]);
    expect(parseLine("\x1b[1;2m\x1b[22mA").style[0]).toBe("");
    const diff = new FrameDiff();
    diff.render("\x1b[1m\x1b[38;5;254mABC\x1b[39m\x1b[22m", 10, 1);
    expect(diff.render("\x1b[38;5;254;1mABC\x1b[0m", 10, 1)!.output).toBe("\x1b[1;1H");
  });

  it("redraws everything after a resize or once invalidated, and rewrites forced cells", () => {
    const diff = new FrameDiff();
    const frame = [line("one", 10), line("two", 10)].join("\n");
    expect(diff.render(frame, 10, 2)!.damage.all).toBe(true);
    expect(diff.render(frame, 10, 2)!.output).toBe("\x1b[2;1H");
    expect(diff.render(frame, 12, 2)!.damage.all).toBe(true);
    diff.invalidate();
    expect(diff.render(frame, 12, 2)!.output).toMatch(/^\x1b\[0m\x1b\[H\x1b\[2J/);
    diff.force(1, 2, 5);
    const forced = diff.render(frame, 12, 2)!;
    expect(forced.output).toContain("\x1b[2;3H");
    expect([...forced.damage.spans.entries()]).toEqual([[1, [[2, 5]]]]);
  });

  it("recognizes Ink's frames and nothing else", () => {
    expect(frameText("\x1b[2K\x1b[1A\x1b[2K\x1b[G\x1b[31mhi\x1b[39m\nthere")).toBe("\x1b[31mhi\x1b[39m\nthere");
    expect(frameText("first frame")).toBe("first frame");
    expect(frameText("\x1b[2K\x1b[G")).toBe("");
    for (const other of ["", "\x1b[?1049h", "\x1b[?25l", "\x1b[2J\x1b[3J\x1bHframe", "a\tb", "\x1bP0;1;0q#0~\x1b\\"]) expect(frameText(other)).toBeUndefined();
  });

  it("leaves the cursor on the frame's last line, where Ink's next erase starts", () => {
    const diff = new FrameDiff();
    expect(diff.render("a\nb\nc", 5, 5)!.output.endsWith("\x1b[3;1H")).toBe(true);
    expect(diff.render("a\nb\nc\n", 5, 5)!.output.endsWith("\x1b[4;1H")).toBe(true);
    expect(diff.render("a\nb\nc\nd\ne\nf", 5, 5)).toBeUndefined();
  });
});

describe("the app through the tracked terminal", () => {
  it("shows exactly Ink's frame after every kind of update", async () => {
    const { EventEmitter } = await import("node:events");
    const { createElement } = await import("react");
    const { render } = await import("ink");
    const { App } = await import("../src/ui/App.tsx");
    const { trackTerminal } = await import("../src/image-rendering.ts");
    const { FakeImsg } = await import("../src/imsg/fake.ts");
    const { createSession } = await import("../src/session.ts");
    const { setTheme } = await import("../src/ui/theme.ts");
    const chalk = (await import("chalk")).default;
    const level = chalk.level;
    chalk.level = 2;
    const now = Date.now();
    const fake = new FakeImsg({
      chats: [1, 2, 3, 4].map((id) => ({ id, guid: `iMessage;-;+1555000000${id}`, identifier: `+1555000000${id}`, service: "iMessage" as const, is_group: false, contact_name: `Friend ${id} 💕`, participants: [`+1555000000${id}`], unread_count: id === 2 ? 1 : 0 })),
      messages: [1, 2, 3, 4].flatMap((id) => Array.from({ length: 6 }, (_, index) => ({ id: id * 10 + index, chat_id: id, guid: `m-${id}-${index}`, sender: `+1555000000${id}`, is_from_me: index % 2 === 1, text: index === 3 ? "see https://example.com/a and 日本語" : `message ${index} from ${id}`, created_at: now - (10 - index) * 60_000 - id * 1_000 }))),
    });
    const session = createSession({ connect: () => fake.connect(), journal: { load: async () => undefined, save: async () => undefined, flush: async () => undefined } });
    const screen = new TextTerminal(100, 30);
    const sink = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 100, rows: 30,
      write(data: string | Uint8Array, ...rest: unknown[]) {
        screen.feed(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        (rest.find((value) => typeof value === "function") as (() => void) | undefined)?.();
        return true;
      },
    });
    const tracked = trackTerminal(sink as unknown as NodeJS.WriteStream);
    let last = "";
    const recorder = new Proxy(tracked, {
      get(target, property) {
        if (property === "write") return (data: string | Uint8Array, ...rest: unknown[]) => {
          const frame = frameText(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
          if (frame !== undefined) last = frame;
          return target.write(data as string, ...(rest as []));
        };
        return Reflect.get(target, property, target);
      },
    });
    const keys = Object.assign(new EventEmitter(), {
      isTTY: true, queue: [] as string[], setEncoding() {}, setRawMode() {}, resume() {}, pause() {}, ref() {}, unref() {},
      read() { return keys.queue.shift() ?? null; },
      press(text: string) { keys.queue.push(text); keys.emit("readable"); },
    });
    const app = render(createElement(App, { session }), {
      stdout: recorder, stdin: keys as unknown as NodeJS.ReadStream, interactive: true, alternateScreen: true,
      incrementalRendering: false, exitOnCtrlC: false, patchConsole: false, maxFps: 1000,
    });
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const check = async (label: string) => {
      await pause(120);
      expect(screen.snapshot(), label).toEqual(drawn(last, sink.columns, sink.rows));
    };
    try {
      await session.start();
      await check("the list");
      for (const key of ["j", "j", "k", "\r", "k", "k", "j", "i", "h", "i", "!", "\x7f", "\x1b", "L", "\t", "j", "L"]) {
        keys.press(key);
        await check(`after ${JSON.stringify(key)}`);
      }
      // Every update so far went out as cells within their rows.
      expect(screen.wraps).toBe(0);
      // On a resize Ink first writes its previous layout whole at the new size, which passes
      // through untouched; the frame after it is drawn from scratch.
      sink.columns = 80;
      sink.rows = 24;
      screen.resize(80, 24);
      sink.emit("resize");
      await check("after a resize");
    } finally {
      app.unmount();
      await session.close();
      setTheme("dark");
      chalk.level = level;
    }
  }, 20_000);
});
