import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createElement } from "react";
import { render } from "ink";
import { App } from "../src/ui/App.tsx";
import { cleanupImages, configureGraphics, repaintImages, sixelPlacements, trackTerminal } from "../src/image-rendering.ts";
import { FakeImsg } from "../src/imsg/fake.ts";
import { createSession } from "../src/session.ts";
import { SixelTerminal, sixelProblems } from "./support/sixel-terminal.ts";

// The whole app, rendered as the CLI renders it (whole frames diffed into changed cells,
// synchronized output, the alternate screen), writing to a model of Windows Terminal's
// sixel behavior.

class FakeTerminal extends EventEmitter {
  isTTY = true;
  constructor(public columns: number, public rows: number, private readonly sink: (text: string) => void) { super(); }
  write(data: string | Uint8Array, ...rest: unknown[]): boolean {
    this.sink(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    (rest.find((value) => typeof value === "function") as (() => void) | undefined)?.();
    return true;
  }
}

class FakeKeyboard extends EventEmitter {
  isTTY = true;
  private readonly queue: string[] = [];
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => this.queue.shift() ?? null;
  press(text: string) { this.queue.push(text); this.emit("readable"); }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let directory = "";

beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "tuimsg-sixel-")); });
afterAll(async () => {
  configureGraphics(undefined);
  await rm(directory, { recursive: true, force: true });
});

describe("sixel previews", () => {
  it("stay whole while Ink redraws around them, and leave nothing behind", async () => {
    configureGraphics({ protocol: "sixel", cell: { width: 10, height: 20 } });
    const photo = join(directory, "landscape.png");
    const portrait = join(directory, "portrait.jpg");
    const gradient = Buffer.alloc(320 * 200 * 3);
    for (let index = 0; index < 320 * 200; index++) gradient.set([index % 320 * 0.8, (index / 320) * 1.2, 180], index * 3);
    await writeFile(photo, await sharp(gradient, { raw: { width: 320, height: 200, channels: 3 } }).png().toBuffer());
    await writeFile(portrait, await sharp({ create: { width: 90, height: 160, channels: 3, background: "#e3a340" } }).jpeg().toBuffer());
    const now = Date.now();
    const wife = "+15550009999";
    const fake = new FakeImsg({
      chats: [
        { id: 1, guid: `any;-;${wife}`, identifier: wife, service: "iMessage", is_group: false, contact_name: "Riley", participants: [wife], unread_count: 0 },
        ...[2, 3, 4, 5, 6].map((id) => ({ id, guid: `iMessage;-;+1555000000${id}`, identifier: `+1555000000${id}`, service: "iMessage" as const, is_group: false, contact_name: `Friend ${id}`, participants: [`+1555000000${id}`], unread_count: 0 })),
      ],
      messages: [
        ...Array.from({ length: 6 }, (_, index) => ({ id: index + 1, chat_id: 1, guid: `early-${index}`, sender: wife, is_from_me: index % 2 === 1, text: `Earlier message ${index}`, created_at: now - 600_000 + index * 1_000 })),
        { id: 20, chat_id: 1, guid: "photo-1", sender: wife, is_from_me: false, text: "Look at this", created_at: now - 300_000, attachments: [{ transfer_name: "landscape.png", mime_type: "image/png", total_bytes: 1, original_path: photo }] },
        { id: 21, chat_id: 1, guid: "text-1", sender: wife, is_from_me: true, text: "Nice", created_at: now - 200_000 },
        { id: 22, chat_id: 1, guid: "photo-2", sender: wife, is_from_me: false, text: "And this", created_at: now - 100_000, attachments: [{ transfer_name: "portrait.jpg", mime_type: "image/jpeg", total_bytes: 1, original_path: portrait }] },
        ...[2, 3, 4, 5, 6].map((id) => ({ id: 30 + id, chat_id: id, guid: `friend-${id}`, sender: `+1555000000${id}`, is_from_me: false, text: `Hello from ${id}`, created_at: now - 400_000 - id * 1_000 })),
      ],
    });
    const session = createSession({ connect: () => fake.connect(), journal: { load: async () => undefined, save: async () => undefined, flush: async () => undefined } });
    const terminal = new SixelTerminal(100, 48);
    const out = new FakeTerminal(100, 48, (text) => terminal.feed(text));
    const keyboard = new FakeKeyboard();
    const app = render(createElement(App, { session }), {
      stdout: trackTerminal(out as unknown as NodeJS.WriteStream), stdin: keyboard as unknown as NodeJS.ReadStream,
      stderr: new FakeTerminal(100, 30, () => undefined) as unknown as NodeJS.WriteStream,
      interactive: true, alternateScreen: true, incrementalRendering: false, exitOnCtrlC: false, patchConsole: false,
      onRender: () => repaintImages(),
    });
    const problems = () => sixelProblems(terminal, sixelPlacements(out.rows, out.columns));
    const until = async (condition: () => boolean, label: string) => {
      const deadline = Date.now() + 5_000;
      while (!condition()) {
        if (Date.now() > deadline) {
          const placements = sixelPlacements(out.rows, out.columns);
          throw new Error(`timed out waiting for ${label}: ${placements.length} placements ${JSON.stringify(placements.map((placement) => placement.area))}, sent ${terminal.sixelBytes} sixel bytes, problems ${problems().slice(0, 6).join("; ")} (${problems().length})`);
        }
        await pause(20);
      }
      await pause(150);
    };
    const press = async (key: string) => { keyboard.press(key); await pause(120); };
    // The screen converges once decoding, settling, and painting finish; it must then stay exact.
    const settled = async (label: string) => {
      const deadline = Date.now() + 5_000;
      let calmSince = Date.now();
      let bytes = terminal.sixelBytes;
      while (Date.now() - calmSince < 400) {
        if (Date.now() > deadline) throw new Error(`${label} never settled: ${problems().slice(0, 4).join("; ")} (${problems().length})`);
        await pause(20);
        if (problems().length || terminal.sixelBytes !== bytes) { calmSince = Date.now(); bytes = terminal.sixelBytes; }
      }
      expect(problems()).toEqual([]);
    };
    try {
      await session.start();
      await until(() => session.getSnapshot().chats.size === 6, "the chat list");
      await press("\r");
      await until(() => sixelPlacements(out.rows, out.columns).length === 2, "both previews registered");
      await settled("both previews on screen");

      // Moving through the list rewrites only list cells, so no picture goes out again.
      await press("\t");
      await press("\t");
      expect(session.getSnapshot().input.kind).toBe("list");
      const full = sixelPlacements(out.rows, out.columns).reduce((total, { strips }) => total + strips.join("").length, 0);
      for (const key of ["j", "j", "k", "j"]) {
        const before = terminal.sixelBytes;
        await press(key);
        await settled(`the list after ${key}`);
        expect(terminal.sixelBytes - before).toBe(0);
      }

      await press("\t");
      expect(session.getSnapshot().input.kind).toBe("transcript");
      for (const key of ["\x1b[5~", "\x1b[6~", "k", "k", "j"]) {
        await press(key);
        await settled(`the transcript after ${JSON.stringify(key)}`);
      }

      // A fast wheel scroll shows placeholders while moving and sends each picture about once.
      const beforeWheel = terminal.sixelBytes;
      for (const direction of [64, 64, 65, 64, 65, 65]) {
        keyboard.press(`\x1b[<${direction};60;20M`);
        await pause(15);
      }
      await settled("the transcript after a wheel burst");
      expect(terminal.sixelBytes - beforeWheel).toBeLessThan(full * 1.5);

      // The viewer replaces the inline previews with one large picture.
      await press("j");
      await press("v");
      await until(() => session.getSnapshot().input.kind === "image" && sixelPlacements(out.rows, out.columns).length === 1, "the viewer image");
      await settled("the viewer image");
      expect(sixelPlacements(out.rows, out.columns)[0]!.area.height).toBeGreaterThan(10);
      await press("\x1b");
      await until(() => sixelPlacements(out.rows, out.columns).length === 2, "previews registered after the viewer");
      await settled("previews after the viewer");

      // A new message scrolls the transcript and reorders nothing here, but moves every row.
      fake.deliver({ chat_id: 1, guid: "live", sender: wife, is_from_me: false, text: "One more thing", created_at: Date.now() });
      await until(() => session.getSnapshot().messages.get(`any;-;${wife}` as never)?.some((message) => message.guid === "live") === true, "the live message");
      await settled("the transcript after a live message");

      // A resize redraws everything at the new size.
      terminal.resize(120, 52);
      out.columns = 120;
      out.rows = 52;
      out.emit("resize");
      await pause(100);
      await until(() => sixelPlacements(out.rows, out.columns).length >= 1, "previews registered after a resize");
      await settled("previews after a resize");
    } finally {
      app.unmount();
      await session.close();
      cleanupImages();
    }
  }, 30_000);
});
