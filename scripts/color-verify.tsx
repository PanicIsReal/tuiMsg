import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import sharp from "sharp";
import { render } from "ink-testing-library";
import { App } from "../src/ui/App.tsx";
import { emptyState, type AppState, type Message, type Session } from "../src/domain/model.ts";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../src/domain/ids.ts";
import { previewFromUrl } from "../src/links.ts";
import { ansiCells, ansiSvg } from "./ansi-colors.ts";

const directory = process.argv[2] ?? "/tmp/imsg-color-proof";
await mkdir(directory, { recursive: true });
const chatGuid = parseChatGuid("iMessage;-;color-proof");
const friend = { address: parseHandleAddress("sam@example.test"), service: "iMessage" as const, contact: { displayName: "Sam Rivera", phones: [], emails: [parseHandleAddress("sam@example.test")] } };
const me = { address: parseHandleAddress("me@example.test"), service: "iMessage" as const };
const now = Date.now();
const bodies = ["Are we still on for tomorrow?", "Yes. I have the notes ready.", "Perfect, let's meet at ten.", "I'll bring coffee. See you then!"];
const messages: Message[] = bodies.map((body, index) => ({ kind: "text", guid: parseMessageGuid(`color-message-${index}`), chatGuid, from: index % 2 ? me : friend, isFromMe: Boolean(index % 2), body, attachments: [], sentAt: now - (4 - index) * 60_000, status: "sent" }));
const state: AppState = { ...emptyState(), connection: "online", chatsStatus: "ready", selected: chatGuid, listCursor: chatGuid, input: { kind: "composer", chatGuid },
  chats: new Map([[chatGuid, { guid: chatGuid, kind: "dm", service: "iMessage", title: "Sam Rivera", participants: [friend], unreadCount: 0, muted: false, lastMessage: { body: bodies.at(-1) ?? "", sentAt: now, isFromMe: true } }]]),
  messages: new Map([[chatGuid, messages]]), history: new Map([[chatGuid, { kind: "ready", next: null }]]), drafts: new Map([[chatGuid, { text: "Sounds good", replyTo: null }]]) };
const session: Session = { getSnapshot: () => state, subscribe: () => () => {}, act: () => {}, loadAttachment: async () => new Uint8Array(), loadLinkPreview: async (url) => previewFromUrl(url), start: async () => {}, close: async () => {} };
for (const columns of [80, 180]) {
  const app = render(<App session={session} />);
  Object.defineProperties(app.stdout, { columns: { value: columns, configurable: true }, rows: { value: 30, configurable: true } });
  app.stdout.emit("resize");
  await new Promise(resolve => setTimeout(resolve, 120));
  const ansi = app.lastFrame() ?? "";
  assert(ansi.includes("\x1b["), "color evidence must retain ANSI styling");
  await writeFile(join(directory, `level-${chalk.level}-${columns}.ansi`), ansi);
  for (const light of [true, false]) {
    const svg = ansiSvg(ansi, columns, light);
    const prefix = join(directory, `level-${chalk.level}-${columns}-${light ? "light" : "dark"}-default`);
    await writeFile(`${prefix}.svg`, svg);
    await sharp(Buffer.from(svg)).png().toFile(`${prefix}.png`);
  }
  const cells = ansiCells(ansi);
  const defaultBackground = cells.flat().filter(cell => cell.background === "#ffffff");
  assert.equal(defaultBackground.length, 0, "every app cell must paint its background when the terminal default is white");
  console.log(JSON.stringify({ colorLevel: chalk.level, columns, paintedCells: cells.flat().length, defaultBackgroundCells: defaultBackground.length }));
  app.unmount();
}
