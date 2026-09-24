import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { stripVTControlCharacters } from "node:util";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../../src/domain/ids.ts";
import { previewBody, type TextMessage } from "../../src/domain/model.ts";
import { Box } from "ink";
import { Bubble } from "../../src/ui/Bubble.tsx";
import { MouseProvider } from "../../src/ui/mouse.tsx";

const message = (partial: Partial<TextMessage>): TextMessage => ({
  kind: "text", guid: parseMessageGuid("m"), chatGuid: parseChatGuid("any;-;+15550009999"), sentAt: Date.parse("2026-09-24T08:09:00"),
  from: { address: parseHandleAddress("+15550009999"), service: "iMessage" }, isFromMe: false, body: "", attachments: [], status: "sent", ...partial,
});

function frame(value: TextMessage): string {
  const bubble = createElement(Bubble, { message: value, chips: [], showReceipt: false, grouped: true, selected: false, width: 70, onSelect: () => undefined });
  const app = render(createElement(MouseProvider, null, createElement(Box, { width: 70, flexDirection: "column" }, bubble)));
  const text = stripVTControlCharacters(app.lastFrame() ?? "");
  app.unmount();
  return text;
}

describe("app and link messages", () => {
  it("names an iMessage app message instead of calling it empty", () => {
    const handwriting = message({ body: "￼", balloon: "com.apple.Handwriting.HandwritingProvider" });
    expect(frame(handwriting)).toContain("Handwritten message · shown only in Messages");
    expect(previewBody(handwriting)).toBe("Handwritten message");
    expect(previewBody(message({ body: "￼", balloon: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.gamerdelights.gamepigeon.ext" }))).toBe("Message from an iMessage app");
  });

  it("shows a link as its text, with no stray files", () => {
    const link = message({ body: "https://x.com/bbcnews/status/2103094240074936603?s=46", balloon: "com.apple.messages.URLBalloonProvider" });
    const shown = frame(link);
    expect(shown).toContain("https://x.com/bbcnews/status/2103094240074936603?s=46");
    expect(shown).not.toMatch(/Empty message|shown only in Messages|↓/);
  });

  it("previews attachment-only messages by file name, not Messages' placeholder", () => {
    const photo = message({ body: "￼", attachments: [{ guid: "m/0", name: "IMG_8802.HEIC", mime: "image/heic", bytes: 1 }] });
    expect(previewBody(photo)).toBe("[IMG_8802.HEIC]");
  });
});
