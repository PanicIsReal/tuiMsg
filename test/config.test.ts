import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataDirectory, parseArgs, resolveImsg } from "../src/config.ts";

afterEach(() => { vi.unstubAllEnvs(); });

async function executable(directory: string, name: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
  return path;
}

describe("config", () => {
  it("accepts the documented flags and rejects the retired BlueBubbles setup flag", () => {
    expect(parseArgs(["--fake"])).toEqual({ help: false, version: false, fake: true, fakeRpc: false });
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(() => parseArgs(["--setup"])).toThrow(/Unknown option/);
  });

  it("keeps drafts under TUIMSG_HOME when set", () => {
    vi.stubEnv("TUIMSG_HOME", "/tmp/tuimsg-home");
    expect(dataDirectory()).toBe("/tmp/tuimsg-home");
  });

  it("finds imsg on PATH, and prefers an explicit IMSG_PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuimsg-path-"));
    const imsg = await executable(directory, "imsg");
    expect(await resolveImsg({ PATH: `/nonexistent:${directory}` })).toBe(imsg);
    expect(await resolveImsg({ PATH: directory, IMSG_PATH: "/opt/custom/imsg" })).toBe("/opt/custom/imsg");
  });

  it("skips files that are not executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuimsg-noexec-"));
    await writeFile(join(directory, "imsg"), "not a program");
    const found = await resolveImsg({ PATH: directory });
    expect(found).not.toBe(join(directory, "imsg"));
  });
});
