import { createElement } from "react";
import { render, type Instance } from "ink";
import { SetupScreen, type SetupState, type SetupView } from "./ui/Setup.tsx";
import { stdin, stdout } from "node:process";
import { BbClient, BbError } from "./bb/rest.ts";
import { parseConfig, saveConfig, saveFileConfig, savePendingConfig, type Config } from "./config.ts";

export class SetupCancelled extends Error {}

export type PromptIo = {
  ask(question: string, secret?: boolean): Promise<string>;
  write(text: string): void;
  close?(): void | Promise<void>;
};

export type SetupOptions = { reuseServer?: boolean };

export function terminalPromptIo(): PromptIo {
  let state: SetupState = { lines: "", prompt: null };
  const listeners = new Set<() => void>();
  let app: Instance | undefined;
  let rejectPrompt: ((error: SetupCancelled) => void) | undefined;
  const publish = () => { for (const listener of listeners) listener(); };
  const cancel = () => { rejectPrompt?.(new SetupCancelled()); };
  const view: SetupView = {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel,
  };
  const start = () => {
    if (app) return;
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("Connection setup requires a terminal. Run imsg --setup.");
    app = render(createElement(SetupScreen, { view }), { exitOnCtrlC: false, patchConsole: false, interactive: true });
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    stdin.on("end", cancel);
  };
  return {
    write: text => { start(); state = { ...state, lines: state.lines + text }; publish(); },
    ask: (question, secret = false) => {
      start();
      return new Promise<string>((resolve, reject) => {
        rejectPrompt = reject;
        state = { ...state, prompt: { question, secret, submit(value) {
          rejectPrompt = undefined;
          state = { ...state, prompt: null };
          publish();
          resolve(value);
        } } };
        publish();
      });
    },
    close: async () => {
      app?.unmount();
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      stdin.off("end", cancel);
      await app?.waitUntilExit();
      stdin.pause();
      stdin.unref();
    },
  };
}

export async function setupConfig(io: PromptIo = terminalPromptIo(), currentUrl?: string, options: SetupOptions = {}): Promise<Config> {
  let url = currentUrl ?? "http://127.0.0.1:1234";
  io.write("\n  imsg · Connect your messages\n\n");
  io.write(options.reuseServer && currentUrl
    ? `  Using saved server ${url}.\n  Enter its password to reconnect. Use imsg --setup to change servers.\n`
    : "  Enter your BlueBubbles server address and server password.\n  A bare IP uses port 1234. Use a full URL for HTTPS.\n");
  io.write("  Ctrl+C cancels. Ctrl+U clears the current field.\n\n");
  let active: BbClient | undefined;
  let cancelled = false;
  const cancel = () => { cancelled = true; void active?.close(); };
  process.on("SIGINT", cancel);
  try {
    while (true) {
      if (!options.reuseServer || !currentUrl) {
        const address = (await io.ask(`  1/2 · BlueBubbles server address [${url}]: `)).trim() || url;
        try { url = parseConfig({ url: address, password: "validation" }).url; }
        catch {
          io.write("  Enter a valid IP address or HTTP/HTTPS URL without credentials.\n\n");
          continue;
        }
      }
      const password = await io.ask(options.reuseServer && currentUrl ? "  BlueBubbles password: " : "  2/2 · BlueBubbles password: ", true);
      if (!password.trim()) {
        io.write("  The server password cannot be empty. Try again.\n\n");
        continue;
      }
      const config = { url, password };
      io.write("\n  Checking connection…\n");
      active = new BbClient({ ...config, timeoutMs: 5000 });
      try {
        await active.serverInfo();
      } catch (error) {
        if (cancelled) throw new SetupCancelled();
        io.write(error instanceof BbError && error.kind === "auth"
          ? "  Password rejected. Check the server password in BlueBubbles.\n\n"
          : "  Cannot connect. Check the address and that BlueBubbles is running.\n\n");
        continue;
      } finally {
        await active.close();
        active = undefined;
      }
      if (cancelled) throw new SetupCancelled();
      if (await saveConfig(config)) {
        io.write("  Connected. Password saved in your system credential store.\n  Opening messages…\n\n");
      } else {
        io.write("  Secure storage is unavailable. Your password has not been saved.\n  The file option stores plaintext, not encrypted, readable only by your account.\n");
        const answer = await io.ask("  Save password in a private config file? [y/N]: ");
        if (answer.trim().toLowerCase() === "y") {
          await saveFileConfig(config);
          io.write("  Password stored in a private config file.\n");
        } else {
          const session = await io.ask("  Connect for this session only? [y/N]: ");
          if (session.trim().toLowerCase() !== "y") throw new SetupCancelled();
          await savePendingConfig(config.url);
        }
      }
      return config;
    }
  } finally {
    process.off("SIGINT", cancel);
    await io.close?.();
  }
}
