import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import sharp from "sharp";
import { render } from "ink-testing-library";
import { App } from "../src/ui/App.tsx";
import { emptyState, type AppState, type Message, type Session } from "../src/domain/model.ts";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../src/domain/ids.ts";
import { ansiCells, ansiSvg } from "./ansi-colors.ts";
import { setTheme } from "../src/ui/theme.ts";

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
const session: Session = { getSnapshot: () => state, subscribe: () => () => {}, act: () => {}, loadAttachment: async () => new Uint8Array(), start: async () => {}, close: async () => {} };
// Terminal defaults no palette entry uses, so an unpainted cell shows up in either theme.
const UNPAINTED = { foreground: "#010203", background: "#fefdfc" };
for (const theme of ["dark", "light"] as const) for (const columns of [80, 180]) {
  setTheme(theme);
  const app = render(<App session={session} />);
  Object.defineProperties(app.stdout, { columns: { value: columns, configurable: true }, rows: { value: 30, configurable: true } });
  app.stdout.emit("resize");
  await new Promise(resolve => setTimeout(resolve, 120));
  const ansi = app.lastFrame() ?? "";
  assert(ansi.includes("\x1b["), "color evidence must retain ANSI styling");
  const name = `${theme}-level-${chalk.level}-${columns}`;
  await writeFile(join(directory, `${name}.ansi`), ansi);
  for (const light of [true, false]) {
    const svg = ansiSvg(ansi, columns, light);
    const prefix = join(directory, `${name}-on-${light ? "light" : "dark"}-terminal`);
    await writeFile(`${prefix}.svg`, svg);
    await sharp(Buffer.from(svg)).png().toFile(`${prefix}.png`);
  }
  const cells = ansiCells(ansi, UNPAINTED);
  const unpainted = cells.flat().filter(cell => cell.background === UNPAINTED.background);
  assert.equal(unpainted.length, 0, `every ${theme} cell must paint its background, whatever the terminal's default`);
  console.log(JSON.stringify({ theme, colorLevel: chalk.level, columns, paintedCells: cells.flat().length, unpaintedCells: unpainted.length }));
  app.unmount();
}
