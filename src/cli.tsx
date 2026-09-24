import { render, type Instance } from "ink";
import { repaintImages, cleanupImages } from "./image-rendering.ts";
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
  try {
    app = render(<App session={session} />, {
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
