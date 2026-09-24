import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDirectory } from "./config.ts";
import type { ThemeName } from "./ui/theme.ts";

// Preferences that outlive a session. Unknown keys are kept, so older builds do not erase
// what newer ones saved.
export type Settings = { theme?: ThemeName };

export function settingsPath(directory = dataDirectory()): string {
  return join(directory, "settings.json");
}

function readRaw(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// Synchronous, so the saved theme is in place before the first frame.
export function loadSettings(path = settingsPath()): Settings {
  const theme = readRaw(path).theme;
  return theme === "light" || theme === "dark" ? { theme } : {};
}

// Saves run one at a time, so quick toggles never share the temporary file and the last
// choice is the one that stays.
let saving: Promise<void> = Promise.resolve();
export function saveSettings(patch: Settings, path = settingsPath()): Promise<void> {
  const save = saving.then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...readRaw(path), ...patch }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  });
  saving = save.catch(() => undefined);
  return save;
}

// TUIMSG_THEME=light|dark wins, then the saved choice, then the terminal's own background.
export function chooseTheme(env: NodeJS.ProcessEnv, saved: ThemeName | undefined, detected: ThemeName | undefined): ThemeName {
  const forced = env.TUIMSG_THEME?.toLowerCase();
  if (forced === "light" || forced === "dark") return forced;
  if (forced === "auto") return detected ?? "dark";
  return saved ?? detected ?? "dark";
}
