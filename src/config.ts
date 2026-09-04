import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Config = {
  url: string
  password: string
};

export function configPath(): string {
  return process.env.IMSG_CONFIG ?? join(homedir(), ".config", "imsg", "config.json");
}

export async function loadConfig(): Promise<Config | undefined> {
  const fromEnv = envConfig();
  if (fromEnv) return fromEnv;
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.url !== "string" || typeof rec.password !== "string") return undefined;
    return { url: rec.url, password: rec.password };
  } catch {
    return undefined;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function envConfig(): Config | undefined {
  const url = process.env.IMSG_URL;
  const password = process.env.IMSG_PASSWORD;
  if (!url || !password) return undefined;
  return { url, password };
}

export function parseArgs(argv: string[]): {
  help: boolean
  version: boolean
  fake: boolean
} {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    version: argv.includes("--version") || argv.includes("-v"),
    fake: argv.includes("--fake"),
  };
}
