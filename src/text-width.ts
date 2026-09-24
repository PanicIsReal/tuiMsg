import stringWidth from "string-width";

type Options = { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean };

// string-width with a memory. Ink measures every line, word and cell of every frame, and the
// same few thousand strings come back frame after frame. string-width is quick for plain
// ASCII, but a bar, a rule or a middle dot sends a line through Unicode segmentation and
// emoji regexes, which JavaScriptCore runs slowly. The build points every import of
// string-width here, Ink's included.
const LIMIT = 20_000;
const caches = new Map<string, Map<string, number>>();

export default function rememberedWidth(text: string, options?: Options): number {
  const flavor = `${options?.countAnsiEscapeCodes ? "a" : ""}${options?.ambiguousIsNarrow === false ? "w" : ""}`;
  let cache = caches.get(flavor);
  if (!cache) caches.set(flavor, cache = new Map());
  let width = cache.get(text);
  if (width === undefined) {
    width = stringWidth(text, options);
    // Past the limit the cache starts over rather than tracking which entries are stale.
    if (cache.size >= LIMIT) cache.clear();
    cache.set(text, width);
  }
  return width;
}
