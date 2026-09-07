import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeBb } from "../src/bb/fake.ts";
import { setupConfig, SetupCancelled, type PromptIo } from "../src/setup.ts";
import { saveConfig, saveFileConfig } from "../src/config.ts";

vi.mock("../src/config.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/config.ts")>(),
  saveConfig: vi.fn().mockResolvedValue(true),
  saveFileConfig: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.mocked(saveConfig).mockReset().mockResolvedValue(true);
  vi.mocked(saveFileConfig).mockReset().mockResolvedValue(undefined);
});

function prompt(answers: string[]) {
  const output: string[] = [];
  const ask = vi.fn(async (question: string, secret?: boolean) => {
    output.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new SetupCancelled();
    return answer;
  });
  const io: PromptIo = { ask, write: text => { output.push(text); } };
  return { io, ask, output };
}

describe("interactive setup", () => {
  it("retries rejected credentials before saving and asks for a masked password", async () => {
    const fake = new FakeBb();
    await fake.listen(0);
    const { io, ask, output } = prompt([fake.url, "wrong-password", "", fake.password]);
    try {
      expect(await setupConfig(io)).toEqual({ url: fake.url, password: fake.password });
      expect(saveConfig).toHaveBeenCalledExactlyOnceWith({ url: fake.url, password: fake.password });
      expect(ask.mock.calls.filter(([, secret]) => secret)).toHaveLength(2);
      expect(output.join("")).toContain("Password rejected");
      expect(output.join("")).not.toContain(fake.password);
    } finally { await fake.close(); }
  });

  it("does not connect or save invalid addresses and cancelled input", async () => {
    const { io, output } = prompt(["not an address"]);
    await expect(setupConfig(io)).rejects.toBeInstanceOf(SetupCancelled);
    expect(output.join("")).toContain("Enter a valid IP");
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("asks before continuing with session-only credentials", async () => {
    vi.mocked(saveConfig).mockResolvedValue(false);
    const fake = new FakeBb();
    await fake.listen(0);
    const { io, output } = prompt(["", fake.password, "n"]);
    try {
      await expect(setupConfig(io, fake.url)).rejects.toBeInstanceOf(SetupCancelled);
      expect(output.join("")).toContain("session only");
      expect(output.join("")).not.toContain("Password saved");
    } finally { await fake.close(); }
  });

  it("reuses a saved server and asks only for its password", async () => {
    const fake = new FakeBb();
    await fake.listen(0);
    const { io, ask } = prompt([fake.password]);
    try {
      await expect(setupConfig(io, fake.url, { reuseServer: true })).resolves.toEqual({ url: fake.url, password: fake.password });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0]?.[0]).toContain("password");
    } finally { await fake.close(); }
  });

  it("requires explicit consent before writing the plaintext fallback", async () => {
    vi.mocked(saveConfig).mockResolvedValue(false);
    const fake = new FakeBb();
    await fake.listen(0);
    const { io, output } = prompt([fake.url, fake.password, "y"]);
    try {
      await expect(setupConfig(io)).resolves.toEqual({ url: fake.url, password: fake.password });
      expect(saveFileConfig).toHaveBeenCalledExactlyOnceWith({ url: fake.url, password: fake.password });
      expect(output.join("")).toContain("plaintext");
    } finally { await fake.close(); }
  });
});
