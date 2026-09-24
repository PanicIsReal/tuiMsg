import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Benchmark, keyNames, redact } from "../src/benchmark.ts";
import { parseArgs } from "../src/config.ts";

describe("naming keys for the log", () => {
  it("names commands, and only says typing in a text field", () => {
    expect(keyNames("j", "list")).toEqual(["j"]);
    expect(keyNames("\x1b[A\x1b[B\r\t\x7f\x1b", "list")).toEqual(["up", "down", "enter", "tab", "backspace", "esc"]);
    expect(keyNames("\x1b[5~\x1b[24~\x1bOP\x1b[1;5C", "list")).toEqual(["page up", "f12", "f1", "right"]);
    expect(keyNames("\x01\n", "list")).toEqual(["ctrl+a", "ctrl+j"]);
    expect(keyNames("hi there", "composer")).toEqual(["typing"]);
    // A message typed before the composer was open, a key at a time, shows only its commands.
    expect(["R", "e", "l", "a", "p"].flatMap((key) => keyNames(key, "transcript"))).toEqual(["R", "other", "other", "a", "other"]);
    expect(keyNames("3", "list")).toEqual(["other"]);
    expect(keyNames("3", "tapback")).toEqual(["3"]);
    // Text typed as a field opens can arrive with the key that opened it.
    expect(keyNames("ihello", "transcript")).toEqual(["typing"]);
    expect(keyNames("jjj", "list")).toEqual(["j", "j", "j"]);
    expect(keyNames("\x1bh", "list")).toEqual(["alt+key"]);
    expect(keyNames("\x1b[200~pasted secret\x1b[201~", "composer")).toEqual(["paste"]);
  });

  it("names the wheel and clicks, and leaves out releases and motion", () => {
    expect(keyNames("\x1b[<65;10;5M\x1b[<64;10;5M\x1b[<0;3;4M\x1b[<0;3;4m\x1b[<35;3;4M", "transcript")).toEqual(["wheel down", "wheel up", "click"]);
  });
});

describe("the benchmark flag", () => {
  it("takes an optional file", () => {
    expect(parseArgs([]).benchmark).toBeUndefined();
    expect(parseArgs(["--benchmark"]).benchmark).toBe("");
    expect(parseArgs(["--benchmark", "--fake"])).toMatchObject({ benchmark: "", fake: true });
    expect(parseArgs(["--benchmark", "run.log", "--fake"])).toMatchObject({ benchmark: "run.log", fake: true });
    expect(parseArgs(["--benchmark=run.log"]).benchmark).toBe("run.log");
    expect(() => parseArgs(["run.log"])).toThrow(/Unknown option/);
  });
});

describe("redacting error text", () => {
  it("hides the home directory, addresses and numbers", () => {
    expect(redact(`open '${join(homedir(), "Downloads", "a.jpg")}'`)).toBe(`open '${join("~", "Downloads", "a.jpg")}'`);
    expect(redact("no chat with friend@example.com or +1 (555) 123-4567")).toBe("no chat with <address> or <number>");
    expect(redact("imsg stopped (exit 1)")).toBe("imsg stopped (exit 1)");
  });
});

describe("a benchmark log", () => {
  function run(steps: (benchmark: Benchmark) => void): string {
    const directory = mkdtempSync(join(tmpdir(), "tuimsg-bench-"));
    const file = join(directory, "run.log");
    try {
      const benchmark = new Benchmark();
      benchmark.start(file, ["header line"]);
      steps(benchmark);
      benchmark.finish("quit");
      return readFileSync(file, "utf8");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("times each key to the frame that shows it, with the frame's cost", () => {
    const text = run((benchmark) => {
      benchmark.input("j", "list");
      benchmark.input(null, "list");
      benchmark.inkRendered(4);
      benchmark.diffed(0.5, 480, false);
      benchmark.flushed(512, true);
      benchmark.request("messages.history", 120, 4_096);
      benchmark.sent(160_000, 150);
      benchmark.request("send", 30_000, 0, "timed out");
    });
    expect(text).toMatch(/^header line\n/);
    expect(text).toMatch(/key j · list · on screen [\d.]+ ms · handled [\d.]+ ms · Ink 4\.0 ms · diff 0\.50 ms · 512 B/);
    expect(text).toContain("imsg messages.history · 120 ms · 4.0 KB");
    expect(text).toContain("write · 156.3 KB held the program for 150 ms");
    expect(text).toMatch(/writes 150 ms · 1 held the program over 20 ms/);
    expect(text).toContain("imsg send · 30.00 s · 0 B · timed out");
    expect(text).toContain("end · quit");
    expect(text).toMatch(/keys → screen\s+1 keys/);
    expect(text).toMatch(/imsg requests\s+send\s+1 · 30\.00 s · 0 B\n\s+messages\.history\s+1 · 120 ms · 4\.0 KB\n\s+1 timed out/);
  });

  it("does not credit a key with a later key's frame", () => {
    const text = run((benchmark) => {
      benchmark.input("\x1b[<65;1;1M", "transcript");
      benchmark.input(null, "transcript");
      const until = performance.now() + 60;
      while (performance.now() < until) { /* the next key comes later than a held frame */ }
      benchmark.input("i", "transcript");
      benchmark.input(null, "transcript");
      benchmark.flushed(300, true);
    });
    expect(text).toMatch(/key wheel down · transcript · handled [\d.]+ ms · no change on screen/);
    expect(text).toMatch(/key i · transcript · on screen/);
    expect(text).toMatch(/1 changed nothing on screen/);
  });

  it("keeps what was typed out, and marks F12", () => {
    const text = run((benchmark) => {
      benchmark.input("my secret draft", "composer");
      benchmark.input("\x1b[24~", "composer");
      benchmark.input(null, "composer");
      benchmark.flushed(90, true);
    });
    expect(text).not.toContain("secret");
    expect(text).toContain("key typing · composer · on screen");
    expect(text).toContain("MARK (F12)");
    expect(text).toMatch(/marks\s+1/);
  });
});
