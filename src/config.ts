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
  // Where to write a benchmark log: "" for the default name, undefined when not asked for.
  benchmark: string | undefined
} {
  const known = new Set(["--help", "-h", "--version", "-v", "--fake", "--fake-rpc"]);
  let benchmark: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--benchmark") {
      const next = argv[index + 1];
      benchmark = next !== undefined && !next.startsWith("-") ? (index++, next) : "";
    } else if (arg.startsWith("--benchmark=")) benchmark = arg.slice("--benchmark=".length);
    else rest.push(arg);
  }
  if (rest.some(arg => !known.has(arg))) throw new Error("Unknown option. Run tuimsg --help for usage.");
  return {
    help: rest.includes("--help") || rest.includes("-h"),
    version: rest.includes("--version") || rest.includes("-v"),
    fake: rest.includes("--fake"),
    fakeRpc: rest.includes("--fake-rpc"),
    benchmark,
  };
}
