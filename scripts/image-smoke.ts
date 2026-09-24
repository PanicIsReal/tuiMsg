import { spawn } from "bun";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { FakeImsgOptions } from "../src/imsg/fake.ts";

// Attachments are files Messages stored on this Mac; imsg reports their paths.
const directory = await mkdtemp(join(tmpdir(), "tuimsg-image-pty-"));
const first = await sharp({ create: { width: 120, height: 60, channels: 3, background: "#427fd6" } }).png().toBuffer();
const second = await sharp({ create: { width: 60, height: 120, channels: 3, background: "#e3a340" } }).jpeg().toBuffer();
const stored = join(directory, "Messages", "Attachments");
await mkdir(stored, { recursive: true });
await writeFile(join(stored, "photo-one.png"), first);
await writeFile(join(stored, "photo-two.jpg"), second);
const handle = "+15551230001";
const fixture: FakeImsgOptions = {
  chats: [{ id: 1, guid: `iMessage;-;${handle}`, identifier: handle, service: "iMessage", is_group: false, contact_name: "Jane Doe", participants: [handle], unread_count: 0 }],
  messages: [{ id: 1, chat_id: 1, guid: "photo-message", sender: handle, sender_name: "Jane Doe", is_from_me: false, text: "Photo delivery proof", created_at: Date.now(),
    attachments: [
      { transfer_name: "photo-one.png", mime_type: "image/png", total_bytes: first.length, original_path: join(stored, "photo-one.png") },
      { transfer_name: "photo-two.jpg", mime_type: "image/jpeg", total_bytes: second.length, original_path: join(stored, "photo-two.jpg") },
    ],
  }],
};
const fixturePath = join(directory, "fixture.json");
await writeFile(fixturePath, JSON.stringify(fixture));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const results: string[] = [];
try {
  for (const native of [false, true]) {
    let output = "";
    const decoder = new TextDecoder();
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: native ? "xterm-kitty" : "xterm-256color", TERM_PROGRAM: "", TUIMSG_FAKE_FIXTURE: fixturePath, TUIMSG_HOME: join(directory, native ? "native" : "ansi") };
    delete env.KITTY_WINDOW_ID;
    delete env.TMUX;
    const child = spawn([process.execPath, resolve("bin/tuimsg"), "--fake"], { env, terminal: { cols: 100, rows: 35, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } } });
    const terminal = child.terminal;
    assert(terminal);
    const wait = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        assert(child.exitCode === null, `App exited before ${label}`);
        assert(Date.now() < deadline, `Timed out waiting for ${label}`);
        await pause(25);
      }
    };
    const key = async (text: string) => { terminal.write(text); await pause(150); };
    try {
      await wait(() => output.includes("online"), "online inbox");
      await key("\r");
      await wait(() => output.includes("Photo delivery proof"), "received image message");
      await wait(() => native ? output.includes("\x1b_Ga=T") : output.includes("▄"), "rendered photo pixels");
      await key("v");
      await wait(() => output.includes("photo-one.png"), "expanded PNG viewer");
      await key("s");
      const downloads = join(directory, native ? "native/attachments" : "ansi/attachments");
      await wait(() => output.includes("Saved"), "saved original");
      const files = await readdir(downloads);
      assert(files.includes("photo-one.png"));
      assert.deepEqual(await readFile(join(downloads, "photo-one.png")), first);
      await key("\x1b");
      await key("a");
      await key("j");
      await key("\r");
      await wait(() => output.includes("photo-two.jpg"), "second image viewer");
      terminal.resize(50, 16);
      await pause(250);
      await key("\x1b");
      await key("\x03");
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) await pause(25);
      assert.equal(child.exitCode, 0, "image viewer must quit cleanly");
      assert(output.includes("\x1b[?1049l"), "alternate screen must be restored");
      if (native) assert(output.includes("a=d,d=I"), "owned native images must be deleted");
      results.push(native ? "native-kitty-protocol" : "ansi-pixels");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      terminal.close();
    }
  }
  await mkdir(".audit/ink", { recursive: true });
  await writeFile(".audit/ink/images.json", JSON.stringify({ passed: true, realPty: true, localAttachments: true, originalSavedIntact: true, secondImageViewer: true, renderers: results, nativeHardwareDisplay: "not verified" }, null, 2));
  process.stdout.write("Image PTY passed: local PNG/JPEG attachments, ANSI pixels, native Kitty commands, attachment viewer, intact original save, resize and cleanup.\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
