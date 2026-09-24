import { describe, expect, it } from "vitest";
import { firstLink, hyperlink, linkParts } from "../../src/domain/links.ts";

describe("links in message text", () => {
  it("splits text around web links", () => {
    expect(linkParts("see https://www.instagram.com/reel/DOh1/?igsh=MW5 now")).toEqual([
      { text: "see " },
      { text: "https://www.instagram.com/reel/DOh1/?igsh=MW5", url: "https://www.instagram.com/reel/DOh1/?igsh=MW5" },
      { text: " now" },
    ]);
    expect(linkParts("no links here")).toEqual([{ text: "no links here" }]);
  });

  it("leaves sentence punctuation out, but keeps a bracket the link opened", () => {
    expect(firstLink("Look: https://example.com/a.")).toBe("https://example.com/a");
    expect(firstLink("(https://example.com/a)")).toBe("https://example.com/a");
    expect(firstLink("https://en.wikipedia.org/wiki/Heat_(1995_film)!")).toBe("https://en.wikipedia.org/wiki/Heat_(1995_film)");
    expect(firstLink("“https://example.com/b”?")).toBe("https://example.com/b");
    expect(firstLink("just https:// nothing")).toBeUndefined();
  });

  it("finds links written without a scheme, as Messages does", () => {
    expect(linkParts("try www.example.com/menu.")).toEqual([
      { text: "try " }, { text: "www.example.com/menu", url: "https://www.example.com/menu" }, { text: "." },
    ]);
    expect(firstLink("awww.cute")).toBeUndefined();
    expect(firstLink("https://?")).toBeUndefined();
  });

  it("picks the first of several links", () => {
    expect(firstLink("http://one.test and https://two.test")).toBe("http://one.test");
    expect(linkParts("a https://x.test b https://y.test").filter((part) => part.url)).toHaveLength(2);
  });

  it("wraps text in an OSC 8 hyperlink that cannot carry control characters", () => {
    expect(hyperlink("https://x.test", "x")).toBe("\x1b]8;;https://x.test\x1b\\x\x1b]8;;\x1b\\");
    expect(hyperlink("https://x.test/\x1b]2;owned\x07", "x")).toBe("\x1b]8;;https://x.test/]2;owned\x1b\\x\x1b]8;;\x1b\\");
  });
});
