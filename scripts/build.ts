import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";

// Builds dist/cli.js as one file with Ink and React inside, both in their production builds:
// development React and development JSX made every frame several times slower. sharp stays
// outside, since it loads a native library.
const root = fileURLToPath(new URL("..", import.meta.url));
const rememberedWidth = resolve(root, "src/text-width.ts");

// Ink turns every row of cells back into text on each frame, diffing each cell's styles with
// the one before through three Sets. Along a run of one style that diff is always empty, so a
// plain comparison skips it; the output is the same. An unexpected source stops the build.
const STYLE_DIFF = "ret += ansiCodesToString(diffAnsiCodes(chars[i - 1].styles, char.styles));";
const SAME_STYLES = `
function sameStyles(from, to) {
    if (from === to) return true;
    if (from.length !== to.length) return false;
    for (let index = 0; index < from.length; index++) {
        if (from[index].code !== to[index].code || from[index].endCode !== to[index].endCode) return false;
    }
    return true;
}`;
export function patchStyledChars(source: string, path = "styledChars.js"): string {
  if (!source.includes(STYLE_DIFF)) throw new Error(`${path} no longer matches; update scripts/build.ts`);
  return source.replace(STYLE_DIFF, `if (!sameStyles(chars[i - 1].styles, char.styles)) ${STYLE_DIFF}`) + SAME_STYLES;
}

const plugins: BunPlugin = {
  name: "tuimsg",
  setup(build) {
    build.onLoad({ filter: /@alcalzone[\\/]ansi-tokenize[\\/]build[\\/]styledChars\.js$/ }, async (args) => ({
      contents: patchStyledChars(await Bun.file(args.path).text(), args.path), loader: "js",
    }));
    // Every string-width import, Ink's included, goes through the remembering wrapper.
    build.onResolve({ filter: /^string-width$/ }, (args) => args.importer === rememberedWidth ? undefined : { path: rememberedWidth });
    // Ink loads its DevTools bridge only with DEV=true, and that optional package is not installed.
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};

export async function bundle(entry = "src/cli.tsx", outdir = "dist", naming = "cli.js"): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)],
    outdir: resolve(root, outdir),
    naming,
    target: "bun",
    external: ["sharp"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    jsx: { development: false },
    plugins: [plugins],
  });
  if (!result.success) throw new AggregateError(result.logs, "Build failed");
  for (const output of result.outputs) console.log(`${relative(root, output.path)}  ${(output.size / 1024).toFixed(0)} KB`);
}

if (import.meta.main) await bundle();
