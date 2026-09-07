import { describe, expect, it } from "vitest";
import {
  linkCardLine,
  parseHttpUrl,
  parseHttpUrls,
  previewFromUrl,
  resolveLinkPreview,
  splitHttpUrls,
} from "../src/links.ts";
import type { HttpUrl } from "../src/domain/model.ts";

describe("parseHttpUrls", () => {
  it("extracts http and https URLs in appearance order", () => {
    const body = "see http://a.test then https://b.test/x";
    expect(parseHttpUrls(body)).toEqual(["http://a.test", "https://b.test/x"]);
  });

  it("strips trailing punctuation and unmatched closers", () => {
    expect(parseHttpUrls("go https://ex.test.")).toEqual(["https://ex.test"]);
    expect(parseHttpUrls("go https://ex.test!")).toEqual(["https://ex.test"]);
    expect(parseHttpUrls("go https://ex.test?")).toEqual(["https://ex.test"]);
    expect(parseHttpUrls("(see https://ex.test)")).toEqual(["https://ex.test"]);
    expect(parseHttpUrls("see https://ex.test).")).toEqual(["https://ex.test"]);
    expect(parseHttpUrls("path https://ex.test/a(b)")).toEqual(["https://ex.test/a(b)"]);
  });

  it("returns substrings of the body", () => {
    const body = "prefix https://example.test/path?q=1 suffix";
    const [url] = parseHttpUrls(body);
    expect(url).toBeDefined();
    expect(body.includes(url!)).toBe(true);
    expect(url).toBe("https://example.test/path?q=1");
  });

  it("ignores non-http schemes and empty bodies", () => {
    expect(parseHttpUrls("javascript:alert(1)")).toEqual([]);
    expect(parseHttpUrls("ftp://files.test/a")).toEqual([]);
    expect(parseHttpUrls("")).toEqual([]);
    expect(parseHttpUrls("no links here")).toEqual([]);
  });

  it("splitHttpUrls preserves surrounding text", () => {
    expect(splitHttpUrls("before https://ex.test after")).toEqual([
      { kind: "text", text: "before " },
      { kind: "url", url: "https://ex.test" },
      { kind: "text", text: " after" },
    ]);
  });

  it("parseHttpUrl brands a single valid URL and throws otherwise", () => {
    const url = parseHttpUrl("https://ex.test");
    expect(url).toBe("https://ex.test");
    expect(() => parseHttpUrl("not a url")).toThrow(/http\(s\)/);
    expect(() => parseHttpUrl("javascript:alert(1)")).toThrow(/http\(s\)/);
  });
});

describe("preview formatting", () => {
  it("uses hostname without leading www", () => {
    const url = parseHttpUrl("https://www.Example.test/path");
    expect(previewFromUrl(url)).toEqual({ kind: "host", url, site: "example.test" });
  });

  it("formats card lines and collapses title===site", () => {
    const url = parseHttpUrl("https://ex.test");
    expect(linkCardLine({ kind: "host", url, site: "ex.test" })).toBe("ex.test");
    expect(linkCardLine({ kind: "page", url, site: "GitHub", title: "Repo" })).toBe("GitHub · Repo");
    expect(linkCardLine({ kind: "page", url, site: "GitHub", title: "GitHub" })).toBe("GitHub");
    expect(linkCardLine({ kind: "media", url, site: "YouTube", title: "Song", author: "Artist" })).toBe("YouTube · Song · Artist");
    expect(linkCardLine({ kind: "media", url, site: "YouTube", title: "YouTube", author: "Artist" })).toBe("YouTube");
  });
});

describe("resolveLinkPreview", () => {
  it("maps YouTube oEmbed JSON to media", async () => {
    const url = parseHttpUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const preview = await resolveLinkPreview(url, {
      fetch: async (input: string) => {
        expect(input).toContain("youtube.com/oembed");
        return Response.json({
          title: "Never Gonna Give You Up",
          author_name: "Rick Astley",
          provider_name: "YouTube",
        });
      },
    });
    expect(preview).toEqual({
      kind: "media",
      url,
      site: "YouTube",
      title: "Never Gonna Give You Up",
      author: "Rick Astley",
    });
  });

  it("maps GitHub-like OG HTML to page", async () => {
    const url = parseHttpUrl("https://github.com/panic/tuimsg");
    const html = `
      <html><head>
        <meta property="og:site_name" content="GitHub" />
        <meta property="og:title" content="panic/tuimsg: Messages TUI" />
        <title>Ignored</title>
      </head></html>
    `;
    const preview = await resolveLinkPreview(url, {
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
    });
    expect(preview).toEqual({
      kind: "page",
      url,
      site: "GitHub",
      title: "panic/tuimsg: Messages TUI",
    });
  });

  it("returns host for empty HTML and throws on network failure or abort", async () => {
    const url = parseHttpUrl("https://empty.test/");
    await expect(resolveLinkPreview(url, {
      fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    })).resolves.toEqual({ kind: "host", url, site: "empty.test" });

    await expect(resolveLinkPreview(url, {
      fetch: async () => { throw new Error("network down"); },
    })).rejects.toThrow(/network down/);

    const controller = new AbortController();
    controller.abort();
    await expect(resolveLinkPreview(url, {
      signal: controller.signal,
      fetch: async () => new Response("nope"),
    })).rejects.toThrow();
  });
});

describe("HttpUrl branding", () => {
  it("keeps branded strings assignable as HttpUrl", () => {
    const urls: HttpUrl[] = parseHttpUrls("https://branded.test");
    expect(urls).toHaveLength(1);
  });
});
