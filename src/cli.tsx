import { mkdirSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { render, type Instance } from "ink";
import { benchmark, describeEnvironment, describeLater, instrument, redact } from "./benchmark.ts";
import { cleanupImages, configureGraphics, repaintImages, trackTerminal } from "./image-rendering.ts";
import { chooseTheme, loadSettings, saveSettings } from "./settings.ts";
import { restoreColors, themeColors } from "./terminal-colors.ts";
import { detectTerminal } from "./terminal-graphics.ts";
import { currentTheme, onThemeChange, setTheme, type ThemeName } from "./ui/theme.ts";
import { dataDirectory, parseArgs, resolveImsg } from "./config.ts";
import { runFakeImsgRpc } from "./imsg/fake.ts";
import { childConnector, type RpcConnector } from "./imsg/rpc.ts";
import { createSession } from "./session.ts";
import { App } from "./ui/App.tsx";

const VERSION = "0.2.0";

const HELP = `tuimsg · Messages TUI over imsg

Usage:
  tuimsg                     open Messages on this Mac (over SSH: ssh -t <mac> tuimsg)
  tuimsg --fake              demo data, no Messages access required
  tuimsg --benchmark [file]  also record timings to a log (F12 marks a moment)
  tuimsg --help

Requires imsg (brew install steipete/tap/imsg) and Full Disk Access for the
terminal, or for SSH sessions ("Allow full disk access for remote users").
Set IMSG_PATH to use a specific imsg binary.

Copy uses OSC 52 so SSH sessions can write the local clipboard.
Attachments opened over SSH are saved on the Mac and their path is shown.
Pictures use kitty graphics or sixel (Windows Terminal 1.22+) when the terminal
supports them, else colored blocks; over a link slower than 250 ms, blocks too.
TUIMSG_IMAGES=kitty|sixel|blocks overrides.
Shift+L switches light and dark; the choice is saved. With none saved, tuimsg
matches the terminal's background. TUIMSG_THEME=light|dark|auto overrides.
While it runs, the terminal's default colors follow the theme; quitting restores them.
Links open with o (over SSH: copied to your clipboard) or Ctrl+click.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`tuimsg ${VERSION}\n`);
    return;
  }
  if (args.fakeRpc) {
    await runFakeImsgRpc();
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tuimsg needs an interactive terminal. Over SSH, allocate one: ssh -t <your-mac> tuimsg");
  }

  let connect: () => RpcConnector;
  let imsg: string | undefined;
  if (args.fake) {
    // The demo runs this same program as its imsg child, so it exercises the real stdio path.
    const entry = process.argv[1] ?? "";
    connect = () => childConnector(process.execPath, [entry, "--fake-rpc"]);
  } else {
    imsg = await resolveImsg();
    if (!imsg) throw new Error("imsg was not found. Install it on this Mac with: brew install steipete/tap/imsg (or set IMSG_PATH).");
    const command = imsg;
    connect = () => childConnector(command, ["rpc"]);
  }
  if (args.benchmark !== undefined) startBenchmark(args.benchmark, args.fake ? "demo (--fake)" : imsg);

  let app: Instance | undefined;
  let closing = false;
  const session = createSession({
    connect,
    ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
    quit: close,
  });

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    let failure: unknown;
    try {
      await session.close();
    } catch (error) {
      failure = error;
    } finally {
      cleanupImages();
      app?.unmount();
      await app?.waitUntilExit();
    }
    if (failure) {
      process.stderr.write(`Shutdown failed: ${failure instanceof Error ? failure.message : String(failure)}\n`);
      process.exitCode = 1;
    }
  }

  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  // Asked before Ink takes stdin: whether pictures can be drawn in full (kitty or sixel),
  // whether the terminal is light or dark, and its colors, to put back on exit.
  const settings = loadSettings();
  const terminal = await detectTerminal(process.stdin, process.stdout, process.env);
  configureGraphics(terminal.graphics);
  setTheme(chooseTheme(process.env, settings.theme, terminal.background));
  if (benchmark.on) {
    const { protocol, cell } = terminal.graphics;
    benchmark.note(`terminal ${process.stdout.columns}×${process.stdout.rows} · ${["no", "16", "256", "16 million"][chalk.level]} colors · pictures ${protocol}${protocol === "blocks" ? "" : ` on ${cell.width}×${cell.height} px cells`} · ${currentTheme()} theme · ${terminal.roundTrip === undefined ? "the terminal did not answer its probe" : `the terminal answered in ${terminal.roundTrip.toFixed(1)} ms`}`);
    instrument(process.stdin, process.stdout, session);
  }
  // The margin around the grid takes the theme's canvas. Sixteen-color themes use the
  // terminal's own palette, whose exact colors are unknown, so they leave it alone.
  let tinted = false;
  const tint = (theme: ThemeName) => {
    if (chalk.level < 2) return;
    process.stdout.write(themeColors(theme));
    tinted = true;
  };
  // Also runs after a crash; only a lost connection skips it.
  process.once("exit", () => {
    if (tinted) try { writeSync(1, restoreColors(terminal.colors)); } catch { /* the terminal is gone */ }
  });
  tint(currentTheme());
  onThemeChange((theme) => {
    tint(theme);
    void saveSettings({ theme }).catch(() => undefined);
  });
  try {
    app = render(<App session={session} />, {
      // Ink hands each whole frame to the tracked terminal, which sends only the cells that
      // changed (a keystroke is then a few hundred bytes over SSH) and redraws the sixels
      // that a write erased.
      stdout: trackTerminal(process.stdout),
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
      incrementalRendering: false,
      interactive: true,
      onRender: (metrics) => {
        repaintImages();
        if (benchmark.on) benchmark.inkRendered(metrics.renderTime);
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
  if (benchmark.on) session.act({ type: "notice", notice: { kind: "info", text: "Recording a benchmark log · F12 marks a moment" } });
  void session.start();
}

// Written as it runs, and summed up however the run ends: quit, crash, or a dropped SSH link.
function startBenchmark(requested: string, imsg: string | undefined): void {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const name = `tuimsg-benchmark-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.log`;
  const header = describeEnvironment(VERSION, imsg);
  const candidates = requested ? [resolve(requested)] : [resolve(name), join(dataDirectory(), name)];
  let failure: unknown;
  for (const file of candidates) {
    try {
      mkdirSync(resolve(file, ".."), { recursive: true });
      benchmark.start(file, header);
      break;
    } catch (error) { failure = error; }
  }
  if (!benchmark.on) throw new Error(`Could not write the benchmark log: ${failure instanceof Error ? failure.message : String(failure)}`);
  benchmark.note("started");
  describeLater(imsg && !imsg.startsWith("demo") ? imsg : undefined);
  process.once("exit", (code) => {
    benchmark.finish(code ? `exit code ${code}` : "quit");
    try { writeSync(2, `Benchmark log: ${benchmark.file}\n`); } catch { /* the terminal is gone */ }
  });
  // An SSH link that drops hangs the program up, which would otherwise end it with no summary.
  process.once("SIGHUP", () => {
    benchmark.finish("the terminal hung up");
    process.exit(129);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (benchmark.on) benchmark.note(`crash · ${redact(error instanceof Error ? `${error.name}: ${message}` : message)}`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
