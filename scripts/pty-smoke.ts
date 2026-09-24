import { spawn } from "bun";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

// Drives the compiled app in a real PTY. Its demo imsg child logs every JSON-RPC request.
const directory = await mkdtemp(join(tmpdir(), "tuimsg-pty-"));
const artifacts = resolve(process.env.IMSG_VERIFY_DIR ?? ".audit/pty");
const requestLog = join(directory, "imsg-requests.ndjson");
let output = "";
const decoder = new TextDecoder();
const binary = resolve(process.argv[2] ?? "bin/tuimsg");
// 256 colors whatever the caller's environment, so the theme's colors reach the terminal.
const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "2", TUIMSG_HOME: directory, TUIMSG_FAKE_LOG: requestLog };
delete env.NO_COLOR;
const child = spawn([process.execPath, binary, "--fake"], {
  env,
  terminal: {
    cols: 80,
    rows: 24,
    data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); },
  },
});
const openedTerminal = child.terminal;
assert(openedTerminal, "the application must have a real PTY");
const terminal = openedTerminal;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, description: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}; subprocess exit=${child.exitCode}`);
    await sleep(25);
  }
}
async function key(value: string): Promise<void> {
  terminal.write(value);
  await sleep(90);
}
async function paste(value: string): Promise<void> {
  await key(`\x1b[200~${value}\x1b[201~`);
}
async function toList(): Promise<void> { await key("\x1b"); await key("\x1b"); }
type Sent = { chat_guid?: string; to?: string; text: string };
let sent: Sent[] = [];
async function readSends(): Promise<Sent[]> {
  const log = await readFile(requestLog, "utf8").catch(() => "");
  sent = log.split("\n").filter(Boolean).map(line => JSON.parse(line) as { method: string; params: Sent }).filter(request => request.method === "send").map(request => request.params);
  return sent;
}
async function waitForSend(text: string, description: string): Promise<Sent> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const match = (await readSends()).find(message => message.text === text);
    if (match) return match;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}; sent=${JSON.stringify(sent)}`);
    await sleep(25);
  }
}
// The demo lists Jane (newest), then Sam, then the Weekend group.
const first = { guid: "iMessage;-;+15551230001" };
const second = { guid: "SMS;-;+15551230002" };
const group = { guid: "iMessage;+;chat000111222" };

try {
  await waitFor(() => output.includes("Messages") && output.includes("online"), "the online inbox");
  await key("\r");
  await key("i");
  await paste("PTY first?");
  await key("\r");
  assert.equal((await waitForSend("PTY first?", "Enter to send the first message")).chat_guid, first.guid);

  // The composer keeps focus after sending. Over SSH, text typed right before Enter
  // often arrives in the same read.
  await key("coalesced\r");
  assert.equal((await waitForSend("coalesced", "a send whose Enter arrived with its text")).chat_guid, first.guid);

  await key("line one");
  await key("\n");
  await key("line two");
  await key("\r");
  await waitForSend("line one\nline two", "Ctrl+J to insert a newline before sending");

  await toList();
  await key("j");
  await key("\r");
  await key("i");
  await paste("Sam draft");
  await toList();
  await key("k");
  await key("\r");
  await key("i");
  await paste("Jane draft");
  await toList();
  await key("j");
  await key("\r");
  await key("i");
  await key("\r");
  assert.equal((await waitForSend("Sam draft", "the second conversation's retained draft")).chat_guid, second.guid);
  assert(!(await readSends()).some(message => message.text === "Jane draft"), "the other recipient's draft must stay unsent");

  await toList();
  await key("/");
  await paste("Weekend");
  await key("\r");
  await key("\r");
  await key("i");
  await paste("PTY group");
  await key("\r");
  assert.equal((await waitForSend("PTY group", "search result conversation send")).chat_guid, group.guid);
  assert.equal((await readSends()).length, 5, "input routing must not send extra messages");

  terminal.resize(50, 16);
  await sleep(250);
  await key("\x1b");
  await key("?");
  await key("\x1b");
  await toList();
  await key("q");
  await waitFor(() => child.exitCode !== null, "clean quit", 5000);
  assert.equal(await child.exited, 0, "the terminal session must exit cleanly");
  assert(output.includes("\x1b[?1049h"), "the application must enter the alternate screen");
  assert(output.includes("\x1b[?1049l"), "the application must restore the terminal");
  const tint = output.lastIndexOf("\x1b]11;rgb:");
  assert(tint >= 0, "the terminal's default colors must follow the theme while the app runs");
  assert(output.indexOf("\x1b]110\x07\x1b]111\x07", tint) > tint, "quitting must give the terminal its own colors back");
  assert(!output.includes("memory leak detected"), "keyboard listeners must not accumulate");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "session.ansi"), output);
  await writeFile(join(artifacts, "session.txt"), stripVTControlCharacters(output));
  await writeFile(join(artifacts, "result.json"), JSON.stringify({
    passed: true, realPty: true, binary, sends: sent,
    sizes: [[80, 24], [50, 16]], terminalRestored: true,
  }, null, 2));
  process.stdout.write("PTY smoke passed: real input, coalesced Enter, Ctrl+J, send, recipient-owned drafts, search, resize, and clean quit.\n");
} catch (error) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "failure.ansi"), output);
  throw error;
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await sleep(100);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await child.exited;
  terminal.close();
  await rm(directory, { recursive: true, force: true });
}
