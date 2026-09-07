import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStoreError, loadConfig, parseArgs, parseConfig, saveConfig, saveFileConfig, savePendingConfig, savedServerUrl } from "../src/config.ts";

const originalConfig = process.env.IMSG_CONFIG;
const secrets = new Map<string, string>();
const directories: string[] = [];

beforeEach(() => {
  vi.stubEnv("IMSG_URL", "");
  vi.stubEnv("IMSG_PASSWORD", "");
});

function useConfigFile(contents?: string): Promise<string> {
  return mkdtemp(join(tmpdir(), "tuimsg-config-")).then(async (directory) => {
    directories.push(directory);
    const path = join(directory, "config.json");
    process.env.IMSG_CONFIG = path;
    if (contents !== undefined) await writeFile(path, contents);
    return path;
  });
}

function useSecrets(available = true, readback?: string): void {
  vi.stubGlobal("Bun", available ? {
    secrets: {
      async get({ name }: { name: string }) { return readback ?? secrets.get(name) ?? null; },
      async set({ name, value }: { name: string; value: string }) { secrets.set(name, value); },
    },
  } : undefined);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  secrets.clear();
  vi.unstubAllGlobals();
  if (originalConfig === undefined) delete process.env.IMSG_CONFIG;
  else process.env.IMSG_CONFIG = originalConfig;
});

describe("configuration boundary", () => {
  it("defaults to the local server when only a password is supplied", () => {
    expect(parseConfig({ password: "secret" })).toEqual({ url: "http://127.0.0.1:1234", password: "secret" });
  });
  it("accepts a bare address and supplies the BlueBubbles port", () => {
    expect(parseConfig({ url: "192.168.1.9", password: "secret" }).url).toBe("http://192.168.1.9:1234");
    expect(parseConfig({ url: "https://bb.example.test:8443", password: "secret" }).url).toBe("https://bb.example.test:8443");
  });
  it("rejects malformed and credential-bearing URLs without echoing the credential", () => {
    for (const url of ["invalid", "file:///tmp/server", "http://user:secret@localhost", "http://localhost?password=secret"]) {
      expect(() => parseConfig({ url, password: "secret" })).toThrow();
      try { parseConfig({ url, password: "secret" }); }
      catch (error) { expect(String(error)).not.toContain("secret"); }
    }
  });
  it("distinguishes invalid configuration from absent configuration", () => {
    expect(() => parseConfig({ password: "" })).toThrow("nonempty");
    expect(() => parseConfig(null)).toThrow("password");
  });
  it("rejects a mistyped argument instead of connecting to the real server", () => {
    expect(() => parseArgs(["--fkae"])).toThrow("Unknown option");
    expect(parseArgs(["--fake"]).fake).toBe(true);
    expect(parseArgs(["--setup"]).setup).toBe(true);
  });

  it("stores and reloads the password through the secure store", async () => {
    const path = await useConfigFile();
    useSecrets();
    expect(await saveConfig({ url: "192.168.1.9", password: "secret" })).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: "http://192.168.1.9:1234", credential: "secure-store" });
    expect(await loadConfig()).toEqual({ url: "http://192.168.1.9:1234", password: "secret" });
  });

  it("leaves an existing config untouched when secure storage fails", async () => {
    const path = await useConfigFile('{"url":"http://old.example.test:1234","credential":"secure-store"}\n');
    useSecrets(false);
    expect(await saveConfig({ url: "http://new.example.test:1234", password: "secret" })).toBe(false);
    expect(await readFile(path, "utf8")).toContain("old.example.test");
  });

  it("rejects a secure-store write when readback does not match", async () => {
    const path = await useConfigFile();
    useSecrets(true, "different-password");
    expect(await saveConfig({ url: "http://mismatch.example.test:1234", password: "secret" })).toBe(false);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy plaintext only after storing its password", async () => {
    const path = await useConfigFile('{"url":"http://legacy.example.test:1234","password":"secret"}\n');
    useSecrets();
    expect(await loadConfig()).toEqual({ url: "http://legacy.example.test:1234", password: "secret" });
    expect(await readFile(path, "utf8")).not.toContain("secret");
  });

  it("keeps a legacy file when migration storage fails", async () => {
    const path = await useConfigFile('{"url":"http://legacy.example.test:1234","password":"secret"}\n');
    useSecrets(false);
    expect(await loadConfig()).toEqual({ url: "http://legacy.example.test:1234", password: "secret" });
    expect(await readFile(path, "utf8")).toContain("secret");
  });

  it("recovers a saved URL without requiring its password", async () => {
    const path = await useConfigFile('{"url":"http://recover.example.test:1234","credential":"secure-store"}\n');
    useSecrets();
    expect(await loadConfig()).toBeUndefined();
    expect(await savedServerUrl()).toBe("http://recover.example.test:1234");
    await writeFile(path, "not json");
    expect(await savedServerUrl()).toBeUndefined();
  });

  it("distinguishes an inaccessible secure store from a missing credential", async () => {
    await useConfigFile('{"url":"http://locked.example.test:1234","credential":"secure-store"}\n');
    useSecrets(false);
    await expect(loadConfig()).rejects.toBeInstanceOf(CredentialStoreError);
  });

  it("supports an explicit private-file fallback", async () => {
    const path = await useConfigFile();
    await saveFileConfig({ url: "http://file.example.test:1234", password: "secret" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: "http://file.example.test:1234", credential: "file", password: "secret" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadConfig()).toEqual({ url: "http://file.example.test:1234", password: "secret" });
  });

  it("remembers the server for an explicit session-only fallback", async () => {
    const path = await useConfigFile();
    await savePendingConfig("http://pending.example.test:1234");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: "http://pending.example.test:1234", credential: "pending" });
    expect(await loadConfig()).toBeUndefined();
    expect(await savedServerUrl()).toBe("http://pending.example.test:1234");
  });
});
