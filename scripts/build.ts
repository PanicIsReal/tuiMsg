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

// Ink keeps caches of each line's parsed styles and widths, but builds a new Output, caches
// and all, for every frame, so every line of every frame was parsed again: the coloured half
// blocks under each picture most of all. Shared across frames, and bounded, unchanged lines
// cost a lookup. Lines clipped by a box are cut once per clip for the same reason.
const OUTPUT_CACHE_LIMIT = 20_000;
const OUTPUT_EDITS: [string, string][] = [
  ["    styledChars = new Map();\n", `    styledChars = new Map();
    slices = new Map();
    getSlice(line, from, to) {
        const key = from + ":" + to + ":" + line;
        let cached = this.slices.get(key);
        if (cached === undefined) {
            cached = sliceAnsi(line, from, to);
            if (this.slices.size >= ${OUTPUT_CACHE_LIMIT}) this.slices.clear();
            this.slices.set(key, cached);
        }
        return cached;
    }
`],
  ["            this.styledChars.set(line, cached);", `            if (this.styledChars.size >= ${OUTPUT_CACHE_LIMIT}) this.styledChars.clear();
            this.styledChars.set(line, cached);`],
  ["            this.widths.set(text, cached);", `            if (this.widths.size >= ${OUTPUT_CACHE_LIMIT}) this.widths.clear();
            this.widths.set(text, cached);`],
  ["            this.blockWidths.set(text, cached);", `            if (this.blockWidths.size >= ${OUTPUT_CACHE_LIMIT}) this.blockWidths.clear();
            this.blockWidths.set(text, cached);`],
  ["export default class Output {", "const sharedCaches = new OutputCaches();\nexport default class Output {"],
  ["    caches = new OutputCaches();", "    caches = sharedCaches;"],
  ["                            return sliceAnsi(line, from, to);", "                            return this.caches.getSlice(line, from, to);"],
];
export function patchOutput(source: string, path = "output.js"): string {
  return OUTPUT_EDITS.reduce((text, [from, to]) => {
    if (text.split(from).length !== 2) throw new Error(`${path} no longer matches; update scripts/build.ts`);
    return text.replace(from, to);
  }, source);
}

const plugins: BunPlugin = {
  name: "tuimsg",
  setup(build) {
    build.onLoad({ filter: /@alcalzone[\\/]ansi-tokenize[\\/]build[\\/]styledChars\.js$/ }, async (args) => ({
      contents: patchStyledChars(await Bun.file(args.path).text(), args.path), loader: "js",
    }));
    build.onLoad({ filter: /[\\/]ink[\\/]build[\\/]output\.js$/ }, async (args) => ({
      contents: patchOutput(await Bun.file(args.path).text(), args.path), loader: "js",
    }));
    // Every string-width import, Ink's included, goes through the remembering wrapper.
    build.onResolve({ filter: /^string-width$/ }, (args) => args.importer === rememberedWidth ? undefined : { path: rememberedWidth });
    // Ink connects to React DevTools, over the ws WebSocket client, only with DEV=true and
    // react-devtools-core installed. Neither ships with the package, so Ink's DevTools modules
    // are left empty and the bundle imports nothing but sharp.
    build.onLoad({ filter: /[\\/]ink[\\/]build[\\/]devtools(?:-window-polyfill)?\.js$/ }, () => ({ contents: "export {};", loader: "js" }));
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
