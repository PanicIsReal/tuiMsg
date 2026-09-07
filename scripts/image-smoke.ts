import { spawn } from "bun";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { FakeBb } from "../src/bb/fake.ts";

const directory = await mkdtemp(join(tmpdir(), "imsg-image-pty-"));
const first = await sharp({ create: { width: 120, height: 60, channels: 3, background: "#427fd6" } }).png().toBuffer();
const second = await sharp({ create: { width: 60, height: 120, channels: 3, background: "#e3a340" } }).jpeg().toBuffer();
const chatGuid = "iMessage;+;+15551230001";
const fake = new FakeBb({
  attachments: { "photo-one": first, "photo-two": second },
  messages: { [chatGuid]: [{ guid: "photo-message", chatGuid, text: "Photo delivery proof", isFromMe: false, dateCreated: Date.now(),
    attachments: [
      { guid: "photo-one", transferName: "photo-one.png", mimeType: "image/png", totalBytes: first.length },
      { guid: "photo-two", transferName: "photo-two.jpg", mimeType: "image/jpeg", totalBytes: second.length },
    ],
  }] },
});
await fake.listen(0);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const results: string[] = [];
try {
  for (const native of [false, true]) {
    let output = "";
    const decoder = new TextDecoder();
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: native ? "xterm-kitty" : "xterm-256color", TERM_PROGRAM: "", IMSG_URL: fake.url, IMSG_PASSWORD: fake.password, IMSG_CONFIG: join(directory, native ? "native/config.json" : "ansi/config.json") };
    delete env.KITTY_WINDOW_ID;
    delete env.TMUX;
    const child = spawn([process.execPath, resolve("bin/imsg")], { env, terminal: { cols: 100, rows: 35, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } } });
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
      assert(!output.includes(fake.password));
      results.push(native ? "native-kitty-protocol" : "ansi-pixels");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      terminal.close();
    }
  }
  assert(fake.requests.some(request => request.path.includes("/photo-one/download")));
  assert(fake.requests.some(request => request.path.includes("/photo-two/download")));
  await mkdir(".audit/ink", { recursive: true });
  await writeFile(".audit/ink/images.json", JSON.stringify({ passed: true, realPty: true, authenticatedDownloads: true, originalSavedIntact: true, secondImageViewer: true, renderers: results, nativeHardwareDisplay: "not verified" }, null, 2));
  process.stdout.write("Image PTY passed: authenticated PNG/JPEG downloads, ANSI pixels, native Kitty commands, attachment viewer, intact original save, resize and cleanup.\n");
} finally {
  await fake.close();
  await rm(directory, { recursive: true, force: true });
}
