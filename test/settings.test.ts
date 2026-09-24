import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseTheme, loadSettings, saveSettings, themeNeedsDetection } from "../src/settings.ts";

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tuimsg-settings-"));
}

describe("settings", () => {
  it("saves the theme privately and reads it back, keeping keys it does not know", async () => {
    const path = join(await directory(), "nested", "settings.json");
    expect(loadSettings(path)).toEqual({});
    await saveSettings({ theme: "light" }, path);
    expect(loadSettings(path)).toEqual({ theme: "light" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, JSON.stringify({ theme: "light", future: 1 }));
    await saveSettings({ theme: "dark" }, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark", future: 1 });
  });

  it("keeps the last of several quick saves", async () => {
    const path = join(await directory(), "settings.json");
    await Promise.all(["light", "dark", "light", "dark", "light"].map((theme) => saveSettings({ theme: theme as "light" | "dark" }, path)));
    expect(loadSettings(path)).toEqual({ theme: "light" });
  });

  it("ignores a damaged or unexpected file", async () => {
    const path = join(await directory(), "settings.json");
    for (const content of ["{", "[]", "null", JSON.stringify({ theme: "sepia" })]) {
      await writeFile(path, content);
      expect(loadSettings(path)).toEqual({});
    }
    await saveSettings({ theme: "light" }, path);
    expect(loadSettings(path)).toEqual({ theme: "light" });
  });

  it("lets TUIMSG_THEME win, then the saved choice, then the terminal, then dark", () => {
    expect(chooseTheme({ TUIMSG_THEME: "Light" }, "dark", "dark")).toBe("light");
    expect(chooseTheme({ TUIMSG_THEME: "auto" }, "dark", "light")).toBe("light");
    expect(chooseTheme({ TUIMSG_THEME: "auto" }, "light", undefined)).toBe("dark");
    expect(chooseTheme({}, "light", "dark")).toBe("light");
    expect(chooseTheme({}, undefined, "light")).toBe("light");
    expect(chooseTheme({ TUIMSG_THEME: "neon" }, undefined, undefined)).toBe("dark");
  });

  it("asks the terminal only when its answer would be used", () => {
    expect(themeNeedsDetection({}, undefined)).toBe(true);
    expect(themeNeedsDetection({}, "dark")).toBe(false);
    expect(themeNeedsDetection({ TUIMSG_THEME: "light" }, undefined)).toBe(false);
    expect(themeNeedsDetection({ TUIMSG_THEME: "auto" }, "dark")).toBe(true);
  });
});
