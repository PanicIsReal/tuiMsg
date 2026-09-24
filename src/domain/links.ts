// Web links in message text, with or without the scheme, as Messages finds them. Punctuation
// that ends a sentence is left out of the link, unless it closes a bracket the link itself
// opened, as in Wikipedia's …/Foo_(film).
const URL = /(?:https?:\/\/|\bwww\.)[^\s<>"]+/gi;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", "\"", "’", "”", ")", "]", "}", "»", "…", "。", "，"]);
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

export type TextPart = { text: string; url?: string };

const count = (text: string, character: string) => text.split(character).length - 1;

function trim(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING.has(url[end - 1]!)) {
    const closing = url[end - 1]!;
    const opening = PAIRS[closing];
    const body = url.slice(0, end);
    if (opening && count(body, opening) >= count(body, closing)) break;
    end -= 1;
  }
  return url.slice(0, end);
}

export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL)) {
    const link = trim(match[0]);
    const url = /^www\./i.test(link) ? `https://${link}` : link;
    if (!/^https?:\/\/[^/?#]*\w/i.test(url)) continue;
    const start = match.index;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: link, url });
    last = start + link.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function firstLink(text: string): string | undefined {
  return linkParts(text).find((part) => part.url)?.url;
}

// OSC 8: terminals such as Windows Terminal open the link on Ctrl+click, even over SSH and
// while the app has the mouse. Control characters never reach here (message text is
// cleaned when parsed), but the URL is stripped of them again as it goes into an escape.
export function hyperlink(url: string, text: string): string {
  const safe = url.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return `\x1b]8;;${safe}\x1b\\${text}\x1b]8;;\x1b\\`;
}
