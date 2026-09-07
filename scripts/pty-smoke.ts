import { spawn } from "bun";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { FakeBb } from "../src/bb/fake.ts";

const directory = await mkdtemp(join(tmpdir(), "tuimsg-pty-"));
const artifacts = resolve(process.env.IMSG_VERIFY_DIR ?? ".audit/pty");
const fake = new FakeBb();
await fake.listen(0);
let output = "";
const decoder = new TextDecoder();
const binary = resolve(process.argv[2] ?? "bin/imsg");
const child = spawn([process.execPath, binary], {
  env: {
    ...process.env,
    TERM: "xterm-256color",
    IMSG_URL: fake.url,
    IMSG_PASSWORD: fake.password,
    IMSG_CONFIG: join(directory, "config.json"),
  },
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
const first = fake.chats[0];
const second = fake.chats[1];
const group = fake.chats.find(chat => chat.displayName === "Weekend");
assert(first && second && group, "demo fixture needs two DMs and a group");

try {
  await waitFor(() => output.includes("Messages") && output.includes("online"), "the online inbox");
  await key("\r");
  await key("i");
  await paste("PTY first?");
  await key("\r");
  await waitFor(() => fake.sent.some(message => message.text === "PTY first?"), "Enter to send the first message");
  assert.equal(fake.sent.find(message => message.text === "PTY first?")?.chatGuid, first.guid);

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
  await waitFor(() => fake.sent.some(message => message.text === "Sam draft"), "the second conversation's retained draft");
  assert.equal(fake.sent.find(message => message.text === "Sam draft")?.chatGuid, second.guid);
  assert(!fake.sent.some(message => message.text === "Jane draft"), "the other recipient's draft must stay unsent");

  await toList();
  await key("/");
  await paste("Weekend");
  await key("\r");
  await key("\r");
  await key("i");
  await paste("PTY group");
  await key("\r");
  await waitFor(() => fake.sent.some(message => message.text === "PTY group"), "search result conversation send");
  assert.equal(fake.sent.find(message => message.text === "PTY group")?.chatGuid, group.guid);
  assert.equal(fake.sent.length, 3, "input routing must not send extra messages");

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
  assert(!output.includes("memory leak detected"), "keyboard listeners must not accumulate");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "session.ansi"), output);
  await writeFile(join(artifacts, "session.txt"), stripVTControlCharacters(output));
  await writeFile(join(artifacts, "result.json"), JSON.stringify({
    passed: true, realPty: true, binary, sends: fake.sent.map(({ chatGuid, text }) => ({ chatGuid, text })),
    sizes: [[80, 24], [50, 16]], terminalRestored: true,
  }, null, 2));
  process.stdout.write("PTY smoke passed: real input, send, recipient-owned drafts, search, resize, and clean quit.\n");
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
  await fake.close();
  await rm(directory, { recursive: true, force: true });
}
