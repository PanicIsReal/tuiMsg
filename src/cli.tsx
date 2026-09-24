import { writeSync } from "node:fs";
import chalk from "chalk";
import { render, type Instance } from "ink";
import { cleanupImages, configureGraphics, repaintImages, trackTerminal } from "./image-rendering.ts";
import { chooseTheme, loadSettings, saveSettings } from "./settings.ts";
import { restoreColors, themeColors } from "./terminal-colors.ts";
import { detectTerminal } from "./terminal-graphics.ts";
import { currentTheme, onThemeChange, setTheme, type ThemeName } from "./ui/theme.ts";
import { parseArgs, resolveImsg } from "./config.ts";
import { runFakeImsgRpc } from "./imsg/fake.ts";
import { childConnector, type RpcConnector } from "./imsg/rpc.ts";
import { createSession } from "./session.ts";
import { App } from "./ui/App.tsx";

const HELP = `tuimsg · Messages TUI over imsg

Usage:
  tuimsg            open Messages on this Mac (over SSH: ssh -t <mac> tuimsg)
  tuimsg --fake     demo data, no Messages access required
  tuimsg --help

Requires imsg (brew install steipete/tap/imsg) and Full Disk Access for the
terminal, or for SSH sessions ("Allow full disk access for remote users").
Set IMSG_PATH to use a specific imsg binary.

Copy uses OSC 52 so SSH sessions can write the local clipboard.
Attachments opened over SSH are saved on the Mac and their path is shown.
Pictures use kitty graphics or sixel (Windows Terminal 1.22+) when the terminal
supports them, else colored blocks. TUIMSG_IMAGES=kitty|sixel|blocks overrides.
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
    process.stdout.write("tuimsg 0.2.0\n");
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
  if (args.fake) {
    // The demo runs this same program as its imsg child, so it exercises the real stdio path.
    const entry = process.argv[1] ?? "";
    connect = () => childConnector(process.execPath, [entry, "--fake-rpc"]);
  } else {
    const imsg = await resolveImsg();
    if (!imsg) throw new Error("imsg was not found. Install it on this Mac with: brew install steipete/tap/imsg (or set IMSG_PATH).");
    connect = () => childConnector(imsg, ["rpc"]);
  }

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
      // Sixels vanish under rewritten text, so Ink's writes are watched to redraw them.
      stdout: trackTerminal(process.stdout),
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
      // Rewrite only changed lines; a full redraw per keystroke is slow over SSH.
      incrementalRendering: true,
      interactive: true,
      onRender: () => repaintImages(),
    });
  } catch (error) {
    await close();
    throw error;
  }
  void session.start();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
