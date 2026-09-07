import { spawn } from "bun";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeBb } from "../src/bb/fake.ts";

const directory = await mkdtemp(join(tmpdir(), "tuimsg-setup-"));
const configPath = join(directory, "config.json");
const fake = new FakeBb();
fake.password = `setup-${crypto.randomUUID()}-é`;
await fake.listen(0);
const binary = resolve("bin/imsg");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", IMSG_CONFIG: configPath };
delete env.IMSG_URL;
delete env.IMSG_PASSWORD;
const runs: ReturnType<typeof launch>[] = [];

function launch(args: string[] = [], config = configPath) {
  let output = "";
  const decoder = new TextDecoder();
  const child = spawn([process.execPath, binary, ...args], {
    env: { ...env, IMSG_CONFIG: config },
    terminal: {
      cols: 80, rows: 24,
      data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); },
    },
  });
  const terminal = child.terminal;
  assert(terminal);
  const run = {
    child, terminal,
    output: () => output,
    async wait(text: string, timeout = 12000) {
      const deadline = Date.now() + timeout;
      while (!output.includes(text)) {
        assert(child.exitCode === null, `Process exited before ${text}`);
        assert(Date.now() < deadline, `Timed out waiting for ${text}`);
        await pause(25);
      }
    },
    async key(text: string) {
      if (text.length > 1 && text.endsWith("\r")) {
        terminal.write(text.slice(0, -1));
        await pause(150);
        terminal.write("\r");
      } else terminal.write(text);
      await pause(150);
    },
    async quit(sendInterrupt = true) {
      if (sendInterrupt) terminal.write("\x03");
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) await pause(25);
      assert(child.exitCode !== null, "Ctrl+C must exit promptly");
      assert.equal(await child.exited, 0);
      assert(!output.includes(fake.password.slice(0, 25)), "Password must never be printed");
    },
  };
  return run;
}

try {
  const first = launch();
  runs.push(first);
  await first.wait("server address");
  await first.key(fake.url.replace("http://", "") + "\r");
  await first.wait("password");
  await first.key("wrong-password\r");
  await first.wait("Password rejected");
  await assert.rejects(readFile(configPath), { code: "ENOENT" });
  await first.key("\r");
  await first.key(`\x1b[200~${fake.password}\x1b[201~\r`);
  await first.wait("online");
  await first.quit();
  const saved = await readFile(configPath, "utf8");
  assert(!saved.includes(fake.password), "Saved config must not contain password");
  const parsed = JSON.parse(saved);
  assert.equal(parsed.url, fake.url);
  assert(!("password" in parsed));
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  const second = launch();
  runs.push(second);
  await second.wait("online");
  assert(!second.output().includes("server address"), "Repeat launch must reuse settings");
  await second.quit();

  await Bun.secrets.delete({ service: "com.tuimsg.imsg", name: `password:${Buffer.from(fake.url).toString("base64url")}` });
  const missingSecret = launch();
  runs.push(missingSecret);
  await missingSecret.wait("password");
  assert(!missingSecret.output().includes("server address"), "Missing secure credential must reuse the saved server");
  await missingSecret.quit();

  const fileConfigPath = join(directory, "file.json");
  await writeFile(fileConfigPath, `${JSON.stringify({ url: fake.url, credential: "file", password: fake.password })}\n`, { mode: 0o600 });
  const fileCredential = launch([], fileConfigPath);
  runs.push(fileCredential);
  await fileCredential.wait("online");
  assert(!fileCredential.output().includes("server address"), "File credential launch must not enter setup");
  await fileCredential.quit();

  const reset = launch(["--setup"]);
  runs.push(reset);
  await reset.wait("server address");
  await reset.quit();
  assert.equal(await readFile(configPath, "utf8"), saved, "Cancelled reconfiguration must preserve settings");

  const signal = launch(["--setup"]);
  runs.push(signal);
  await signal.wait("server address");
  signal.child.kill("SIGINT");
  await signal.wait("Setup cancelled");
  await signal.quit(false);

  const cancelPath = join(directory, "cancel.json");
  const cancel = launch([], cancelPath);
  runs.push(cancel);
  await cancel.wait("server address");
  await cancel.key(fake.url + "\r");
  await cancel.wait("password");
  await cancel.key("never-save-this");
  await cancel.quit();
  assert(!cancel.output().includes("never-save-this"));
  await assert.rejects(readFile(cancelPath), { code: "ENOENT" });

  const noninteractive = spawn([process.execPath, binary], {
    env: { ...env, IMSG_CONFIG: cancelPath }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 5000;
    while (noninteractive.exitCode === null && Date.now() < deadline) await pause(25);
    assert(noninteractive.exitCode !== null, "Noninteractive launch must not hang");
    assert.equal(await noninteractive.exited, 1);
  } finally {
    if (noninteractive.exitCode === null) noninteractive.kill("SIGKILL");
    await noninteractive.exited;
  }
  assert((await new Response(noninteractive.stderr).text()).includes("terminal"));
  const artifacts = resolve(".audit/setup");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: true, realPty: true, nativeCredentialStore: true, firstLaunch: true, repeatLaunch: true, missingSecurePasswordOnly: true, privateFileCredential: true, passwordMasked: true, cancelPreservesConfig: true, configMode: "0600", noninteractive: true }, null, 2));
  process.stdout.write("Setup smoke passed: first launch, native credentials, repeat launch, missing-secret password recovery, private-file credentials, masked Unicode password, cancellation, and noninteractive error.\n");
} catch (error) {
  const artifacts = resolve(".audit/setup");
  await mkdir(artifacts, { recursive: true });
  for (const [index, run] of runs.entries()) {
    await writeFile(join(artifacts, `failure-${index}.txt`), run.output().replaceAll(fake.password, "[REDACTED]"));
  }
  throw error;
} finally {
  for (const run of runs) {
    if (run.child.exitCode === null) run.child.kill("SIGKILL");
    await run.child.exited;
    run.terminal.close();
  }
  try {
    await Bun.secrets.delete({ service: "com.tuimsg.imsg", name: `password:${Buffer.from(fake.url).toString("base64url")}` });
  } finally {
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  }
}
