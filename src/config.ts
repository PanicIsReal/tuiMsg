import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Config = { url: string; password: string };

export type SavedConfig =
  | { url: string; credential: "secure-store" }
  | { url: string; credential: "pending" }
  | { url: string; credential: "file"; password: string };

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export function configPath(): string {
  return process.env.IMSG_CONFIG ?? join(homedir(), ".config", "imsg", "config.json");
}

export async function loadConfig(): Promise<Config | undefined> {
  const fromEnv = envConfig();
  if (fromEnv) return fromEnv;
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read configuration at ${configPath()}. Check its permissions.`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`Configuration at ${configPath()} is not valid JSON.`); }
  if (isLegacyConfig(parsed)) {
    const config = parseConfig(parsed);
    const stored = await storePassword(config.url, config.password);
    if (stored) await saveSavedConfig({ url: config.url, credential: "secure-store" });
    else process.stderr.write("Secure credential storage is unavailable. Your existing config still contains its plaintext password. Run imsg --setup when secure storage is available.\n");
    return config;
  }
  const saved = parseSavedConfig(parsed);
  if (saved.credential === "pending") return undefined;
  if (saved.credential === "file") return { url: saved.url, password: saved.password };
  const password = await loadPassword(saved.url);
  if (password.kind === "unavailable") {
    throw new CredentialStoreError("Cannot access saved credentials. Unlock macOS Keychain or start and unlock your Linux Secret Service keyring, then run imsg again. Use imsg --setup to change the connection or choose another storage option.");
  }
  return password.kind === "found" ? { url: saved.url, password: password.value } : undefined;
}

export async function savedServerUrl(): Promise<string | undefined> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isLegacyConfig(parsed)) {
      return typeof parsed.url === "string" ? parseUrl(parsed.url) : "http://127.0.0.1:1234";
    }
    return parseSavedConfig(parsed).url;
  } catch {
    return undefined;
  }
}

export async function saveConfig(config: Config): Promise<boolean> {
  const validated = parseConfig(config);
  const stored = await storePassword(validated.url, validated.password);
  if (!stored) return false;
  await saveSavedConfig({ url: validated.url, credential: "secure-store" });
  return stored;
}

export async function savePendingConfig(url: string): Promise<void> {
  await saveSavedConfig({ url: parseUrl(url), credential: "pending" });
}

export async function saveFileConfig(config: Config): Promise<void> {
  const validated = parseConfig(config);
  await saveSavedConfig({ url: validated.url, credential: "file", password: validated.password });
}

async function saveSavedConfig(config: SavedConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

const SECRET_SERVICE = "com.tuimsg.imsg";

type SecretApi = {
  get(args: { service: string; name: string }): Promise<string | null>;
  set(args: { service: string; name: string; value: string }): Promise<void>;
};

function secretApi(): SecretApi | undefined {
  if (typeof Bun === "undefined" || !Bun.secrets) return undefined;
  return Bun.secrets;
}

function secretName(url: string): string {
  return `password:${Buffer.from(url).toString("base64url")}`;
}

type LoadedPassword =
  | { kind: "found"; value: string }
  | { kind: "missing" }
  | { kind: "unavailable" };

async function loadPassword(url: string): Promise<LoadedPassword> {
  const api = secretApi();
  if (!api) return { kind: "unavailable" };
  try {
    const value = await api.get({ service: SECRET_SERVICE, name: secretName(url) });
    return value === null ? { kind: "missing" } : { kind: "found", value };
  } catch { return { kind: "unavailable" }; }
}

async function storePassword(url: string, password: string): Promise<boolean> {
  const api = secretApi();
  if (!api) return false;
  try {
    const name = secretName(url);
    await api.set({ service: SECRET_SERVICE, name, value: password });
    return (await api.get({ service: SECRET_SERVICE, name })) === password;
  } catch { return false; }
}

function isLegacyConfig(value: unknown): value is { url?: unknown; password: unknown } {
  return typeof value === "object" && value !== null && "password" in value && !("credential" in value);
}

function parseSavedConfig(value: unknown): SavedConfig {
  if (typeof value !== "object" || value === null || !("url" in value) || !("credential" in value) ||
      typeof value.url !== "string" || (value.credential !== "secure-store" && value.credential !== "pending" && value.credential !== "file")) {
    throw new Error("Configuration is missing a secure credential reference.");
  }
  const url = parseUrl(value.url);
  if (value.credential === "file") {
    if (!("password" in value) || typeof value.password !== "string" || value.password.trim().length === 0) throw new Error("File configuration requires a nonempty password.");
    return { url, credential: "file", password: value.password };
  }
  return value.credential === "pending" ? { url, credential: "pending" } : { url, credential: "secure-store" };
}

export function parseConfig(value: unknown): Config {
  if (typeof value !== "object" || value === null || !("password" in value) ||
      typeof value.password !== "string" || value.password.trim().length === 0) {
    throw new Error("Configuration requires a nonempty BlueBubbles password.");
  }
  const rawUrl = "url" in value ? value.url : "http://127.0.0.1:1234";
  if (typeof rawUrl !== "string") {
    throw new Error("BlueBubbles URL must be an http or https address.");
  }
  return { url: parseUrl(rawUrl), password: value.password };
}

function parseUrl(rawUrl: string): string {
  let url: URL;
  try { url = new URL(normalizeUrl(rawUrl)); }
  catch { throw new Error("BlueBubbles address must be an IP address, hostname, or full http(s) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("BlueBubbles URL must use http or https without embedded credentials, query, or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (!/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[\w.-]+\.[\w.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(trimmed)) {
    throw new Error("BlueBubbles address must be an IP address, hostname, or full http(s) URL.");
  }
  const hasPort = trimmed.startsWith("[") ? /^\[[0-9a-f:]+\]:\d{1,5}$/i.test(trimmed) : trimmed.includes(":");
  return `http://${hasPort ? trimmed : `${trimmed}:1234`}`;
}

function envConfig(): Config | undefined {
  const url = process.env.IMSG_URL;
  const password = process.env.IMSG_PASSWORD;
  if (!url && !password) return undefined;
  return parseConfig({ url: url ?? "http://127.0.0.1:1234", password });
}

export function parseArgs(argv: string[]): {
  help: boolean
  version: boolean
  fake: boolean
  setup: boolean
} {
  const known = new Set(["--help", "-h", "--version", "-v", "--fake", "--setup"]);
  if (argv.some(arg => !known.has(arg))) throw new Error("Unknown option. Run imsg --help for usage.");
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    version: argv.includes("--version") || argv.includes("-v"),
    fake: argv.includes("--fake"),
    setup: argv.includes("--setup"),
  };
}
