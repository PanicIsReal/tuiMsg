import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Drafts, unresolved sends, and saved attachments live here.
export function dataDirectory(): string {
  return process.env.TUIMSG_HOME ?? join(homedir(), ".config", "tuimsg");
}

// SSH sessions often start with a minimal PATH, so also try the Homebrew prefixes.
export async function resolveImsg(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.IMSG_PATH) return env.IMSG_PATH;
  const directories = [...(env.PATH ?? "").split(delimiter).filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const directory of directories) {
    const candidate = join(directory, "imsg");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return undefined;
}

export function parseArgs(argv: string[]): {
  help: boolean
  version: boolean
  fake: boolean
  fakeRpc: boolean
} {
  const known = new Set(["--help", "-h", "--version", "-v", "--fake", "--fake-rpc"]);
  if (argv.some(arg => !known.has(arg))) throw new Error("Unknown option. Run tuimsg --help for usage.");
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    version: argv.includes("--version") || argv.includes("-v"),
    fake: argv.includes("--fake"),
    fakeRpc: argv.includes("--fake-rpc"),
  };
}
