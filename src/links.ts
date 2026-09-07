import { spawn } from "node:child_process";
import type { HttpUrl, LinkPreview } from "./domain/model.ts";

export type BodyPart =
  | { kind: "text"; text: string }
  | { kind: "url"; url: HttpUrl };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCT = /[.,;:!?]$/;
const TRAILING_CLOSER = /[)\]}>]$/;
const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
const MAX_META = 120;
const MAX_HTML_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

const OEMBED_PROVIDERS: Array<{ test: (host: string) => boolean; endpoint: (url: HttpUrl) => string }> = [
  {
    test: (host) => /(^|\.)youtube\.com$/i.test(host) || /^youtu\.be$/i.test(host),
    endpoint: (url) => `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  },
  {
    test: (host) => /(^|\.)tiktok\.com$/i.test(host),
    endpoint: (url) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
  },
];

export function parseHttpUrl(raw: string): HttpUrl {
  const trimmed = trimUrlCandidate(raw.trim());
  if (!isHttpUrl(trimmed)) throw new Error("Not an http(s) URL.");
  return trimmed as HttpUrl;
}

export function parseHttpUrls(body: string): HttpUrl[] {
  return splitHttpUrls(body).flatMap((part) => (part.kind === "url" ? [part.url] : []));
}

export function splitHttpUrls(body: string): BodyPart[] {
  if (!body) return [];
  const parts: BodyPart[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(body)) !== null) {
    const start = match.index;
    const raw = match[0]!;
    const candidate = trimUrlCandidate(raw);
    if (candidate && isHttpUrl(candidate)) {
      if (start > last) parts.push({ kind: "text", text: body.slice(last, start) });
      const url = body.slice(start, start + candidate.length) as HttpUrl;
      parts.push({ kind: "url", url });
      last = start + candidate.length;
    }
  }
  if (last < body.length) parts.push({ kind: "text", text: body.slice(last) });
  if (parts.length === 0) return [{ kind: "text", text: body }];
  return parts;
}

export function previewFromUrl(url: HttpUrl): Extract<LinkPreview, { kind: "host" }> {
  let site = "link";
  try {
    site = new URL(url).hostname.replace(/^www\./i, "") || "link";
  } catch {
    site = "link";
  }
  return { kind: "host", url, site };
}

export function linkCardLine(preview: LinkPreview): string {
  switch (preview.kind) {
    case "host":
      return preview.site;
    case "page":
      return preview.title === preview.site ? preview.site : `${preview.site} · ${preview.title}`;
    case "media":
      return preview.title === preview.site ? preview.site : `${preview.site} · ${preview.title} · ${preview.author}`;
  }
}

export type ResolveLinkOptions = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
};

export async function resolveLinkPreview(url: HttpUrl, options?: ResolveLinkOptions): Promise<LinkPreview> {
  options?.signal?.throwIfAborted();
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const hostCard = previewFromUrl(url);
  const host = new URL(url).hostname;
  const provider = OEMBED_PROVIDERS.find((entry) => entry.test(host));
  if (provider) {
    try {
      const response = await fetchFn(provider.endpoint(url), {
        signal: mergeSignal(options?.signal, FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
        redirect: "follow",
      });
      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        const card = cardFromOEmbed(url, data, hostCard);
        if (card) return card;
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }

  const response = await fetchFn(url, {
    signal: mergeSignal(options?.signal, FETCH_TIMEOUT_MS),
    headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
  });
  const html = await readCapped(response, MAX_HTML_BYTES, options?.signal);
  return cardFromHtml(url, html, hostCard);
}

export async function openHttpUrl(url: HttpUrl): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs can be opened.");
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore", detached: false });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code ?? "unknown"}`))));
  });
}

function trimUrlCandidate(raw: string): string {
  let candidate = raw;
  for (;;) {
    if (TRAILING_PUNCT.test(candidate)) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    const closer = candidate.at(-1);
    if (closer && TRAILING_CLOSER.test(closer)) {
      const opener = OPENERS[closer];
      if (!opener) break;
      let opens = 0;
      let closes = 0;
      for (const char of candidate) {
        if (char === opener) opens += 1;
        if (char === closer) closes += 1;
      }
      if (closes > opens) {
        candidate = candidate.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return candidate;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function cardFromOEmbed(url: HttpUrl, data: Record<string, unknown>, hostCard: Extract<LinkPreview, { kind: "host" }>): LinkPreview | null {
  const title = cleanMeta(typeof data.title === "string" ? data.title : "");
  const author = cleanMeta(typeof data.author_name === "string" ? data.author_name : "");
  const site = cleanMeta(typeof data.provider_name === "string" ? data.provider_name : "") || hostCard.site;
  if (title && author) return { kind: "media", url, site, title, author };
  if (title) return title === site ? { kind: "host", url, site } : { kind: "page", url, site, title };
  if (site !== hostCard.site) return { kind: "host", url, site };
  return null;
}

function cardFromHtml(url: HttpUrl, html: string, hostCard: Extract<LinkPreview, { kind: "host" }>): LinkPreview {
  const ogTitle = cleanMeta(metaContent(html, "og:title"));
  const twitterTitle = cleanMeta(metaContent(html, "twitter:title"));
  const titleTag = cleanMeta(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const title = ogTitle || twitterTitle || titleTag;
  const siteName = cleanMeta(metaContent(html, "og:site_name")) || hostCard.site;
  if (title) return title === siteName ? { kind: "host", url, site: siteName } : { kind: "page", url, site: siteName, title };
  if (siteName !== hostCard.site) return { kind: "host", url, site: siteName };
  return hostCard;
}

function metaContent(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b[^>]*?(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']*)["'][^>]*?>`, "i"),
    new RegExp(`<meta\\b[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']${escaped}["'][^>]*?>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function cleanMeta(value: string): string {
  const decoded = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!decoded) return "";
  return decoded.length > MAX_META ? `${decoded.slice(0, MAX_META - 1)}…` : decoded;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

async function readCapped(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  for (;;) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done || !value) break;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      overflow = true;
      break;
    }
    if (value.byteLength <= remaining) {
      chunks.push(value);
      total += value.byteLength;
    } else {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      overflow = true;
      break;
    }
  }
  if (overflow) await reader.cancel();
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function mergeSignal(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && "any" in AbortSignal && typeof AbortSignal.timeout === "function") {
    const timed = AbortSignal.timeout(timeoutMs);
    return outer ? AbortSignal.any([outer, timed]) : timed;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
