import { render, type Instance } from "ink";
import { repaintImages, cleanupImages } from "./image-rendering.ts";
import { FakeBb } from "./bb/fake.ts";
import { loadConfig, parseArgs, savedServerUrl } from "./config.ts";
import { setupConfig, SetupCancelled } from "./setup.ts";
import { createSession } from "./session.ts";
import { App } from "./ui/App.tsx";

const HELP = `imsg · Messages TUI over BlueBubbles

Usage:
  imsg              set up on first launch, then connect with saved credentials
  imsg --setup      configure the BlueBubbles server and password
  imsg --fake       demo data, no BlueBubbles required
  imsg --help

Copy uses OSC 52 so SSH sessions can write the local clipboard.
Attachments opened over SSH are saved on the server and their path is shown.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write("tuimsg 0.1.0\n");
    return;
  }

  let fake: FakeBb | undefined;
  let url: string;
  let password: string;
  if (args.fake) {
    fake = new FakeBb();
    await fake.listen(0);
    url = fake.url;
    password = fake.password;
  } else {
    let config = args.setup ? undefined : await loadConfig();
    if (!config) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("No saved credentials. Run imsg --setup from a terminal, or set IMSG_URL and IMSG_PASSWORD.");
      }
      const savedUrl = args.setup ? undefined : await savedServerUrl();
      config = await setupConfig(undefined, savedUrl, { reuseServer: !args.setup });
    }
    url = config.url;
    password = config.password;
  }

  let app: Instance | undefined;
  let closing = false;
  const session = createSession({
    url,
    password,
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
      try {
        await fake?.close();
      } catch (error) {
        failure ??= error;
      }
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
      interactive: Boolean(process.stdout.isTTY),
      onRender: () => repaintImages(),
    });
  } catch (error) {
    await close();
    throw error;
  }
  void session.start();
}

main().catch((error) => {
  if (error instanceof SetupCancelled) {
    process.stdout.write("Setup cancelled.\n");
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
