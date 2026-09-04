import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "../../src/ui");

describe("no inline components", () => {
  it("does not declare nested function components in ui/", () => {
    const files = readdirSync(uiDir).filter((f) => f.endsWith(".tsx"));
    for (const file of files) {
      const src = readFileSync(join(uiDir, file), "utf8");
      const nested = /export function \w+\([^)]*\)[^{]*\{[\s\S]*?\n  function [A-Z]/.test(src);
      expect(nested, file).toBe(false);
    }
  });
});
