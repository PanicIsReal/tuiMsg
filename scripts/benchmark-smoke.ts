import { spawn } from "bun";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Runs the compiled app with --benchmark in a real PTY, uses it a little, and checks the log:
// its timeline, its summary, and that nothing typed or read in it (names, numbers, text)
// found its way in.
const directory = await mkdtemp(join(tmpdir(), "tuimsg-benchmark-"));
const log = join(directory, "run.log");
const binary = resolve(process.argv[2] ?? "bin/tuimsg");
const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "2", TUIMSG_HOME: directory };
delete env.NO_COLOR;
let output = "";
const decoder = new TextDecoder();
const child = spawn([process.execPath, binary, "--fake", "--benchmark", log], {
  env,
  terminal: { cols: 100, rows: 30, data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } },
});
const terminal = child.terminal!;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function waitFor(predicate: () => boolean, description: string, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}; exit=${child.exitCode}`);
    await sleep(25);
  }
}
const key = async (value: string) => { terminal.write(value); await sleep(120); };

try {
  await waitFor(() => output.includes("online"), "the online inbox");
  // "isecret" opens the composer and types in one read, as a quick typist over SSH can.
  for (const value of ["j", "k", "\r", "\x1b[<65;60;10M", "isecret", " words", "\x7f", "\x1b", "\x1b[24~", "?", "?"]) await key(value);
  terminal.resize(90, 28);
  await sleep(300);
  await key("\x1b");
  await key("q");
  await waitFor(() => child.exitCode !== null, "the app to quit");
  await waitFor(() => output.includes("Benchmark log:"), "the log's path on exit", 2_000);
  assert.equal(child.exitCode, 0);

  const text = await readFile(log, "utf8");
  for (const expected of [
    "tuiMsg benchmark", "Timings, sizes and counts only", "tuimsg      0.2.0", "imsg        demo (--fake)",
    "started", "terminal 100×30", "first frame on screen", "connection online", "conversations ready",
    "imsg chats.list", "imsg messages.history", "conversation shown", "transcript ready",
    "key j · list · on screen", "key enter · list · on screen", "key wheel down · transcript", "key typing · transcript · on screen", "key typing · composer · on screen",
    "key backspace · composer", "MARK (F12)", "key ? · transcript", "resize · 90×28", "details · commit", "end · quit",
    "──── summary", "keys → screen", "slowest keys", "frames", "terminal output", "imsg requests", "none timed out or failed",
    "event loop", "memory", "marks",
  ]) assert.ok(text.includes(expected), `the log must include ${JSON.stringify(expected)}\n${text}`);
  // Nothing typed, and nothing from the conversations: names, numbers, message text.
  for (const secret of ["secret", "words", "Jane", "Sam", "Alex", "Weekend", "+1555", "5551230001", "Bring chips", "Parking", "coming tonight"]) {
    assert.ok(!text.includes(secret), `the log must not include ${JSON.stringify(secret)}`);
  }
  const artifacts = resolve(process.env.IMSG_VERIFY_DIR ?? ".audit/benchmark");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "run.log"), text);
  console.log(`Benchmark PTY passed: ${text.split("\n").length} lines, timeline and summary, nothing private.`);
} catch (error) {
  console.error(output.slice(-2_000));
  const text = await readFile(log, "utf8").catch(() => "(no log)");
  console.error(text);
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  terminal.close();
  await rm(directory, { recursive: true, force: true });
}
