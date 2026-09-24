import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { render } from "ink-testing-library";
import { stripVTControlCharacters } from "node:util";
import { App } from "../src/ui/App.tsx";
import { emptyState, type AppState, type Chat, type Intent, type Message, type Session } from "../src/domain/model.ts";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../src/domain/ids.ts";
import { currentTheme } from "../src/ui/theme.ts";



const firstChat = parseChatGuid("iMessage;-;chat-one");
const secondChat = parseChatGuid("SMS;-;chat-two");
const firstMessage = parseMessageGuid("message-one");
const secondMessage = parseMessageGuid("message-two");
const me = { address: parseHandleAddress("me@example.com"), service: "iMessage" as const };
const friend = { address: parseHandleAddress("+15550001111"), service: "iMessage" as const, contact: { displayName: "Sam Rivera", phones: [parseHandleAddress("+15550001111")], emails: [] } };
const syntheticPng = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAA1BMVEU7gvbSL5pLAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC", "base64"));
const failedImageAttachment = { guid: "attachment-fail", name: "missing.png", mime: "image/png", bytes: 1 };

let state: AppState = {
  ...emptyState(),
  connection: "online",
  capabilities: { bridge: true },
  chatsStatus: "ready",
  chats: new Map([
    [firstChat, { guid: firstChat, kind: "dm", service: "iMessage", title: "Sam Rivera with a title long enough to truncate", participants: [friend], unreadCount: 2, muted: false, lastMessage: { body: "Can you bring the project notes tomorrow?", sentAt: Date.now(), isFromMe: false } }],
    [secondChat, { guid: secondChat, kind: "dm", service: "SMS", title: "Alex", participants: [], unreadCount: 0, muted: false, lastMessage: { body: "See you soon", sentAt: Date.now() - 10_000, isFromMe: true } }],
  ]),
  messages: new Map([[firstChat, [
    { guid: firstMessage, chatGuid: firstChat, kind: "text", from: friend, isFromMe: false, body: "Can you bring the project notes tomorrow?", attachments: [{ guid: "attachment-one", name: "sample.png", mime: "image/png", bytes: syntheticPng.byteLength }], sentAt: Date.now() - 5_000, status: "sent" },
    { guid: secondMessage, tempGuid: secondMessage, chatGuid: firstChat, kind: "text", from: me, isFromMe: true, body: "Yes, I have them ready.", attachments: [], sentAt: Date.now(), status: "uncertain" },
  ]]]),
  history: new Map([[firstChat, { kind: "ready", next: { before: Date.now() - 5_000 } }]]),
  selected: null,
  listCursor: firstChat,
  input: { kind: "list" },
};

const listeners = new Set<() => void>();
const intents: Intent[] = [];
let peakListeners = 0;
let subscribeCalls = 0;

const session: Session = {
  getSnapshot: () => state,
  subscribe(listener) {
    subscribeCalls += 1;
    listeners.add(listener);
    peakListeners = Math.max(peakListeners, listeners.size);
    return () => { listeners.delete(listener); };
  },
  act(intent) {
    intents.push(intent);
    apply(intent);
    for (const listener of listeners) listener();
  },
  async loadAttachment(attachment) {
    if (attachment.guid === failedImageAttachment.guid) throw new Error("synthetic preview failure");
    return syntheticPng;
  },
  async start() {},
  async close() {},
};

function apply(intent: Intent): void {
  if (intent.type === "input") state = { ...state, input: intent.input };
  else if (intent.type === "move-list") {
    const order = [...state.chats.keys()];
    const index = Math.max(0, order.indexOf(state.listCursor ?? order[0]!));
    state = { ...state, listCursor: order[Math.max(0, Math.min(order.length - 1, index + intent.delta))] ?? null };
  } else if (intent.type === "open-chat") {
    const messages = state.messages.get(intent.chatGuid) ?? [];
    const cursor = messages.findLast((message) => message.kind !== "tapback")?.guid;
    state = { ...state, selected: intent.chatGuid, input: { kind: "transcript", chatGuid: intent.chatGuid },
      messageCursor: cursor ? new Map(state.messageCursor).set(intent.chatGuid, cursor) : state.messageCursor };
  } else if (intent.type === "draft-set") {
    state = { ...state, drafts: new Map(state.drafts).set(intent.chatGuid, { text: intent.text, replyTo: state.drafts.get(intent.chatGuid)?.replyTo ?? null }) };
  } else if (intent.type === "move-message") {
    const messages = (state.messages.get(intent.chatGuid) ?? []).filter((message) => message.kind !== "tapback");
    const current = state.messageCursor.get(intent.chatGuid);
    const index = Math.max(0, messages.findIndex((message) => message.guid === current));
    const next = messages[Math.max(0, Math.min(messages.length - 1, index + intent.delta))];
    if (next) state = { ...state, messageCursor: new Map(state.messageCursor).set(intent.chatGuid, next.guid) };
  } else if (intent.type === "reply") {
    const current = state.drafts.get(intent.chatGuid) ?? { text: "", replyTo: null };
    state = { ...state, drafts: new Map(state.drafts).set(intent.chatGuid, { ...current, replyTo: intent.messageGuid }) };
  } else if (intent.type === "search-set") state = { ...state, search: intent.text };
  else if (intent.type === "select-message") state = { ...state, messageCursor: new Map(state.messageCursor).set(intent.chatGuid, intent.messageGuid) };
  else if (intent.type === "notice") state = { ...state, notice: intent.notice };
}

const app = render(<App session={session} />);
function pressKey(name: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
  const codes: Record<string, string> = { ESCAPE: "\x1b", return: "\r", tab: "\t", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C" };
  app.stdin.write(options.ctrl ? String.fromCharCode(name.toLowerCase().charCodeAt(0) - 96) : codes[name] ?? name);
}
const setup = {
  flush: () => delay(65),
  captureCharFrame: () => stripVTControlCharacters(app.lastFrame() ?? ""),
  resize(width: number, height: number) {
    Object.defineProperty(app.stdout, "columns", { configurable: true, value: width });
    Object.defineProperty(app.stdout, "rows", { configurable: true, value: height });
    app.stdout.emit("resize");
  },
  mockInput: {
    pressKey,
    pressEnter: (options: { shift?: boolean } = {}) => app.stdin.write(options.shift ? "\x1b[13;2u" : "\r"),
    typeText: async (text: string) => { app.stdin.write(text); await delay(65); },
  },
  mockMouse: { scroll: async (x: number, y: number, direction: "up" | "down") => {
    app.stdin.write(`\x1b[<${direction === "up" ? 64 : 65};${x};${y}M`);
    await delay(65);
  } },
};
setup.resize(120, 30);
await setup.flush();
let frame = setup.captureCharFrame();
saveFrame("frame-120x30.txt", frame);
assert.match(frame, /Messages/);
assert.match(frame, /Sam Rive/);
assert.equal(subscribeCalls, 1);
assert.equal(peakListeners, 1);

setup.mockInput.pressKey("j");
await setup.flush();
assert.equal(state.input.kind, "list");
assert.equal(state.listCursor, secondChat);
setup.mockInput.pressEnter();
await setup.flush();
assert.equal(state.selected, secondChat);

state = { ...state, selected: firstChat, input: { kind: "transcript", chatGuid: firstChat }, messageCursor: new Map(state.messageCursor).set(firstChat, firstMessage) };
for (const listener of listeners) listener();
await setup.flush();
await waitForImage();
saveFrame("normal-conversation-120x30.txt", setup.captureCharFrame());
setup.resize(260, 40);
await setup.flush();
const wideFrame = setup.captureCharFrame();
saveFrame("wide-conversation-260x40.txt", wideFrame);
assert.doesNotMatch(wideFrame, /[╭╮╰╯]/, "the conversation should not box each message");
const incomingColumn = wideFrame.split("\n").find(line => line.includes("Can you bring the project notes tomorrow?"))?.indexOf("Can you bring");
const outgoingColumn = wideFrame.split("\n").find(line => line.includes("Yes, I have them ready."))?.indexOf("Yes, I have");
assert.equal(incomingColumn, outgoingColumn, "incoming and outgoing messages must share one reading lane on wide terminals");
assert(wideFrame.split("\n").filter(line => line.includes("─")).every(line => (line.match(/─/g)?.length ?? 0) <= 100), "the reading lane must stay bounded on wide terminals");

setup.resize(100, 35);
await setup.flush();
await waitForImage();
saveFrame("normal-conversation-100x35.txt", setup.captureCharFrame());
setup.resize(80, 24);
await setup.flush();
await waitForImage();
saveFrame("normal-conversation-80x24.txt", setup.captureCharFrame());
setup.resize(120, 30);
await setup.flush();
setup.mockInput.pressKey("?");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "help");
assert.match(setup.captureCharFrame(), /Keyboard shortcuts/);
setup.mockInput.pressKey("?");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "transcript");

setup.mockInput.pressKey("v");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "image");
await waitForImage();
assert.match(setup.captureCharFrame(), /sample\.png/);
saveFrame("image-viewer-120x30.txt", setup.captureCharFrame());
setup.mockInput.pressKey("o");
setup.mockInput.pressKey("s");
await setup.flush();
assert.ok(intents.some((intent) => intent.type === "attachment" && intent.action === "open" && intent.attachment.guid === "attachment-one"));
assert.ok(intents.some((intent) => intent.type === "attachment" && intent.action === "save" && intent.attachment.guid === "attachment-one"));
setup.mockInput.pressKey("ESCAPE");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "transcript");

session.act({ type: "input", input: { kind: "image", attachment: failedImageAttachment, returnTo: { kind: "transcript", chatGuid: firstChat } } });
await delay(20);
await setup.flush();
assert.match(setup.captureCharFrame(), /Preview unavailable/);
setup.mockInput.pressKey("ESCAPE");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "transcript");

setup.mockInput.pressKey("i");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "composer");
await setup.mockInput.typeText("A?B");
await setup.flush();
assert.equal(state.drafts.get(firstChat)?.text, "A?B");
assert.equal(session.getSnapshot().input.kind, "composer");
setup.mockInput.pressEnter({ shift: true });
await setup.mockInput.typeText("C");
setup.mockInput.pressKey("j", { ctrl: true });
await setup.mockInput.typeText("D");
await setup.flush();
assert.equal(state.drafts.get(firstChat)?.text, "A?B\nC\nD");
setup.mockInput.pressEnter();
await setup.flush();
assert.ok(intents.some((intent) => intent.type === "send" && intent.chatGuid === firstChat));
const originalDraft = state.drafts.get(firstChat)?.text ?? "";
session.act({ type: "draft-set", chatGuid: firstChat, text: "" });
setup.resize(50, 16);
await setup.flush();
await setup.mockInput.typeText("Long draft ".repeat(25) + "CURSOR_END");
await setup.flush();
assert.match(setup.captureCharFrame(), /END/, "the last characters and caret must stay visible in a long wrapped draft");
assert(!setup.captureCharFrame().split("\n").some(line => line.startsWith("╰") && line.includes("▄")), "image pixels must not paint over the transcript border");
const sendsBeforePaste = intents.filter(intent => intent.type === "send").length;
app.stdin.write("\x1b[200~pasted\ntext?\x1b[201~");
await setup.flush();
assert.ok(state.drafts.get(firstChat)?.text.endsWith("CURSOR_ENDpasted\ntext?"));
assert.equal(intents.filter(intent => intent.type === "send").length, sendsBeforePaste, "pasted newlines must not send messages");
session.act({ type: "draft-set", chatGuid: firstChat, text: originalDraft });
setup.resize(120, 30);
await setup.flush();

session.act({ type: "input", input: { kind: "help", returnTo: { kind: "composer", chatGuid: firstChat } } });
await setup.flush();
await setup.mockInput.typeText("blocked");
await setup.flush();
assert.equal(state.drafts.get(firstChat)?.text, "A?B\nC\nD");
setup.mockInput.pressKey("?");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "composer");
session.act({ type: "input", input: { kind: "search", returnTo: { kind: "composer", chatGuid: firstChat } } });
await setup.flush();
await setup.mockInput.typeText("Sam");
await setup.flush();
assert.equal(state.search, "Sam");
assert.equal(state.drafts.get(firstChat)?.text, "A?B\nC\nD");
setup.mockInput.pressKey("ESCAPE");
await delay(60);
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "composer");
setup.mockInput.pressKey("ESCAPE");
await delay(60);
await setup.flush();

setup.mockInput.pressKey("k");
await setup.flush();
assert.equal(state.messageCursor.get(firstChat), firstMessage);
setup.mockInput.pressKey("y");
setup.mockInput.pressKey("a");
await setup.flush();
assert.ok(intents.some((intent) => intent.type === "copy" && intent.text.includes("project notes")));
assert.equal(session.getSnapshot().input.kind, "attachments");
setup.mockInput.pressKey("s");
setup.mockInput.pressKey("ESCAPE");
await delay(60);
await setup.flush();
assert.ok(intents.some((intent) => intent.type === "attachment" && intent.action === "save"));
setup.mockInput.pressKey("t");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "tapback");
setup.mockInput.pressEnter();
await setup.flush();
assert.ok(intents.some((intent) => intent.type === "react" && intent.reaction === "love" && !intent.remove));
setup.mockInput.pressKey("r");
await setup.flush();
assert.equal(state.drafts.get(firstChat)?.replyTo, firstMessage);
assert.equal(session.getSnapshot().input.kind, "composer");
setup.mockInput.pressKey("ESCAPE");
await delay(60);
await setup.flush();
// Without imsg's bridge, reply and react explain themselves instead of opening dead ends.
state = { ...state, capabilities: { bridge: false } };
for (const listener of listeners) listener();
await setup.flush();
setup.mockInput.pressKey("t");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "transcript");
assert.ok(intents.some((intent) => intent.type === "notice" && intent.notice?.text.includes("imsg bridge")));
state = { ...state, capabilities: { bridge: true } };
for (const listener of listeners) listener();
await setup.flush();
setup.mockInput.pressKey("j");
await setup.flush();
setup.mockInput.pressKey("!");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "retry-confirm");
setup.mockInput.pressKey("y");
await setup.flush();
assert.ok(intents.some((intent) => intent.type === "retry-send" && intent.confirmed === true));

setup.mockInput.pressKey("/");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "search");
assert.equal(state.search, "Sam");
setup.mockInput.pressKey("ESCAPE");
await delay(60);
await setup.flush();

setup.mockInput.pressKey("n");
await setup.flush();
assert.equal(session.getSnapshot().input.kind, "new-chat");
await setup.mockInput.typeText("friend@example.com");
setup.mockInput.pressEnter();
await setup.flush();
const newChatAfterRecipient = session.getSnapshot().input;
assert.equal(newChatAfterRecipient.kind === "new-chat" ? newChatAfterRecipient.field : "", "text");
await setup.mockInput.typeText("First message?");
await setup.flush();
const newChatAfterText = session.getSnapshot().input;
assert.equal(newChatAfterText.kind === "new-chat" ? newChatAfterText.text : "", "First message?");
setup.mockInput.pressKey("s", { ctrl: true });
await setup.flush();
assert.ok(intents.some((intent) => intent.type === "create-chat" && intent.addresses === "friend@example.com" && intent.text === "First message?"));

const longMessages: Message[] = Array.from({ length: 28 }, (_, index) => ({
  guid: parseMessageGuid(`long-${index}`),
  chatGuid: firstChat,
  kind: "text",
  from: index % 2 ? me : friend,
  isFromMe: index % 2 === 1,
  body: `Long message ${String(index).padStart(2, "0")} anchor with enough text to occupy a readable row`,
  attachments: [],
  sentAt: Date.now() + index,
  status: "sent",
}));
state = {
  ...state,
  selected: firstChat,
  input: { kind: "transcript", chatGuid: firstChat },
  messages: new Map(state.messages).set(firstChat, longMessages),
  messageCursor: new Map(state.messageCursor).set(firstChat, longMessages.at(-1)!.guid),
};
for (const listener of listeners) listener();
setup.resize(50, 16);
await setup.flush();
for (let index = 0; index < 20; index += 1) {
  setup.mockInput.pressKey("k");
  await setup.flush();
}
await delay(50);
await setup.flush();
const readingGuid = state.messageCursor.get(firstChat);
assert.equal(readingGuid, parseMessageGuid("long-7"));
assert.match(setup.captureCharFrame(), /Long message 07 anchor/);
saveFrame("long-scroll-selected.txt", setup.captureCharFrame());

const older: Message[] = Array.from({ length: 3 }, (_, index) => ({
  ...longMessages[0]!,
  guid: parseMessageGuid(`older-${index}`),
  body: `Older message ${index}`,
  sentAt: longMessages[0]!.sentAt - 3 + index,
}));
state = { ...state, messages: new Map(state.messages).set(firstChat, [...older, ...longMessages]) };
for (const listener of listeners) listener();
await setup.flush();
await delay(50);
await setup.flush();
assert.equal(state.messageCursor.get(firstChat), readingGuid);
assert.match(setup.captureCharFrame(), /Long message 07 anchor/);
saveFrame("long-scroll-prepend.txt", setup.captureCharFrame());

const beforeWheel = setup.captureCharFrame();
const cursorBeforeBorderClick = state.messageCursor.get(firstChat);
app.stdin.write("\x1b[<0;20;12M");
await setup.flush();
assert.equal(state.messageCursor.get(firstChat), cursorBeforeBorderClick, "clipped messages must not receive clicks on the transcript border");
await setup.mockMouse.scroll(20, 7, "up");
await setup.mockMouse.scroll(20, 7, "up");
await setup.flush();
assert.notEqual(setup.captureCharFrame(), beforeWheel, "wheel scroll must move the visible transcript");
const beforeLive = setup.captureCharFrame();
const live: Message = {
  ...(longMessages[0] as Extract<Message, { kind: "text" }>),
  guid: parseMessageGuid("live-tail"),
  body: "A background arrival",
  sentAt: Date.now() + 100,
};
state = { ...state, messages: new Map(state.messages).set(firstChat, [...older, ...longMessages, live]) };
for (const listener of listeners) listener();
await setup.flush();
assert.equal(setup.captureCharFrame().split("\n").slice(3).join("\n"), beforeLive.split("\n").slice(3).join("\n"), "background messages must preserve the reading position");
assert.match(setup.captureCharFrame(), /Long message \d+ anchor/);

await setup.mockMouse.scroll(20, 7, "up");
await setup.flush();
const manualFrame = setup.captureCharFrame();
const visibleAnchor = manualFrame.match(/Long message \d+ anchor/)?.[0];
assert(visibleAnchor);
state = { ...state, history: new Map(state.history).set(firstChat, { kind: "loading", request: 99, mode: "older", hasPage: true, next: { before: 1 } }) };
for (const listener of listeners) listener();
await setup.flush();
const moreOlder: Message[] = Array.from({ length: 2 }, (_, index) => ({
  ...(longMessages[0] as Extract<Message, { kind: "text" }>),
  guid: parseMessageGuid(`manual-older-${index}`),
  body: `Manual older ${index}`,
  sentAt: longMessages[0]!.sentAt - 10 + index,
}));
state = {
  ...state,
  messages: new Map(state.messages).set(firstChat, [...moreOlder, ...older, ...longMessages, live]),
  history: new Map(state.history).set(firstChat, { kind: "ready", next: null }),
};
for (const listener of listeners) listener();
await setup.flush();
await delay(50);
await setup.flush();

assert.match(setup.captureCharFrame(), new RegExp(visibleAnchor));

state = {
  ...state,
  messages: new Map(state.messages).set(firstChat, [
    { ...(longMessages[0] as Extract<Message, { kind: "text" }>), guid: parseMessageGuid("switch-older"), body: "Switch older" },
    ...moreOlder, ...older, ...longMessages, live,
  ]),
};
for (const listener of listeners) listener();
state = {
  ...state,
  selected: secondChat,
  input: { kind: "transcript", chatGuid: secondChat },
  history: new Map(state.history).set(secondChat, { kind: "ready", next: null }),
};
for (const listener of listeners) listener();
await delay(10);
await setup.flush();
assert.doesNotMatch(setup.captureCharFrame(), /Switch older|Long message/);

// Resting on the newest message, the transcript follows sends, receipts, arrivals, and typing,
// even while j/k left the selection on a message that is now older.
const tail: Message[] = Array.from({ length: 16 }, (_, index) => ({
  ...(longMessages[0] as Extract<Message, { kind: "text" }>),
  guid: parseMessageGuid(`tail-${index}`),
  body: `Tail ${String(index).padStart(2, "0")} keeps this conversation long`,
  sentAt: Date.now() + 1_000 + index,
}));
state = {
  ...state,
  selected: firstChat,
  input: { kind: "transcript", chatGuid: firstChat },
  messages: new Map(state.messages).set(firstChat, tail),
  messageCursor: new Map(state.messageCursor).set(firstChat, tail.at(-1)!.guid),
};
for (const listener of listeners) listener();
await setup.flush();
assert.match(setup.captureCharFrame(), /Tail 15/);
const followed: Extract<Message, { kind: "text" }> = { ...(tail[1] as Extract<Message, { kind: "text" }>), guid: parseMessageGuid("follow-sent"), from: me, isFromMe: true, body: "Follow the send", sentAt: Date.now() + 2_000, status: "sent" };
state = { ...state, messages: new Map(state.messages).set(firstChat, [...tail, followed]) };
for (const listener of listeners) listener();
await setup.flush();
assert.match(setup.captureCharFrame(), /Follow the send/, "a sent message must scroll into view");
const delivered: Message = { ...followed, status: "delivered" };
state = { ...state, messages: new Map(state.messages).set(firstChat, [...tail, delivered]) };
for (const listener of listeners) listener();
await setup.flush();
assert.match(setup.captureCharFrame(), /Delivered/, "a receipt under the newest message must stay in view");
const arrival: Message = { ...(tail[0] as Extract<Message, { kind: "text" }>), guid: parseMessageGuid("follow-arrival"), body: "Follow the arrival", sentAt: Date.now() + 3_000 };
state = { ...state, messages: new Map(state.messages).set(firstChat, [...tail, delivered, arrival]) };
for (const listener of listeners) listener();
await setup.flush();
assert.match(setup.captureCharFrame(), /Follow the arrival/, "an arrival must scroll into view at the bottom");
state = { ...state, typing: new Map(state.typing).set(firstChat, true) };
for (const listener of listeners) listener();
await setup.flush();
assert.match(setup.captureCharFrame(), /• • •/, "the typing indicator must stay in view at the bottom");
state = { ...state, typing: new Map() };
for (const listener of listeners) listener();
await setup.flush();

const manyChats: Chat[] = Array.from({ length: 18 }, (_, index) => {
  const guid = parseChatGuid(`SMS;-;list-${index}`);
  return {
    guid,
    kind: "dm",
    service: "SMS",
    title: `Conversation ${String(index).padStart(2, "0")} visible cursor`,
    participants: [],
    unreadCount: 0,
    muted: false,
    lastMessage: { body: `Preview ${index}`, sentAt: Date.now() - index, isFromMe: false },
  };
});
state = {
  ...state,
  chats: new Map(manyChats.map((chat) => [chat.guid, chat])),
  search: "",
  listCursor: manyChats[0]!.guid,
  input: { kind: "list" },
};
for (const listener of listeners) listener();
setup.resize(50, 16);
await setup.flush();
for (let index = 0; index < 12; index += 1) {
  setup.mockInput.pressKey("j");
  await setup.flush();
}
assert.equal(state.listCursor, manyChats[12]!.guid);
assert.match(setup.captureCharFrame(), /Conversation 12 visible cursor/);

// A selected message with a link offers o, which opens that link.
const linkMessage = parseMessageGuid("message-link");
const link = "https://www.instagram.com/reel/DOh1/?igsh=MW5";
state = { ...state, selected: secondChat, input: { kind: "transcript", chatGuid: secondChat },
  chats: new Map(state.chats).set(secondChat, { guid: secondChat, kind: "dm", service: "iMessage", title: "Alex", participants: [friend], unreadCount: 0, muted: false, lastMessage: { body: `Watch ${link} lol`, sentAt: Date.now(), isFromMe: false } }),
  messages: new Map(state.messages).set(secondChat, [{ guid: linkMessage, chatGuid: secondChat, kind: "text", from: friend, isFromMe: false, body: `Watch ${link} lol`, attachments: [], sentAt: Date.now(), status: "sent" }]),
  messageCursor: new Map(state.messageCursor).set(secondChat, linkMessage) };
for (const listener of listeners) listener();
setup.resize(120, 30);
await setup.flush();
assert.match(setup.captureCharFrame(), /o open link/, "the status bar must offer the selected message's link");
assert.ok((app.lastFrame() ?? "").includes(`\x1b]8;;${link}\x1b\\`), "links must be OSC 8 hyperlinks for Ctrl+click");
setup.mockInput.pressKey("o");
await setup.flush();
assert.ok(intents.some((intent) => intent.type === "open-link" && intent.url === link));
assert.ok(!intents.some((intent) => intent.type === "attachment" && intent.action === "open" && intents.at(-1) === intent));

// Shift+L switches the theme outside the composer, and is a plain letter inside it.
assert.equal(currentTheme(), "dark");
setup.mockInput.pressKey("L");
await setup.flush();
assert.equal(currentTheme(), "light");
assert.ok(intents.some((intent) => intent.type === "notice" && intent.notice?.text.startsWith("Light mode")));
setup.mockInput.pressKey("L");
await setup.flush();
assert.equal(currentTheme(), "dark");
state = { ...state, input: { kind: "composer", chatGuid: secondChat } };
for (const listener of listeners) listener();
await setup.flush();
setup.mockInput.pressKey("L");
await setup.flush();
assert.equal(currentTheme(), "dark");
assert.equal(state.drafts.get(secondChat)?.text, "L");

// A notice gives the key hints back at the next key, except the one explaining missing access.
state = { ...state, input: { kind: "transcript", chatGuid: secondChat } };
for (const listener of listeners) listener();
session.act({ type: "notice", notice: { kind: "info", text: "Saved at /tmp/photo.png" } });
await setup.flush();
assert.match(setup.captureCharFrame(), /Saved at \/tmp\/photo\.png/);
assert.doesNotMatch(setup.captureCharFrame(), /o open link/);
setup.mockInput.pressKey("j");
await setup.flush();
assert.equal(state.notice, null);
assert.match(setup.captureCharFrame(), /o open link/, "the key hints must come back at the next key");
// Missing access is explained where the conversation goes, and stays there through keys.
state = { ...state, connection: "no-access", unavailable: "Cannot read the Messages database.", selected: null, input: { kind: "list" } };
for (const listener of listeners) listener();
session.act({ type: "notice", notice: { kind: "info", text: "Light mode · Shift+L for dark" } });
setup.mockInput.pressKey("j");
await setup.flush();
assert.equal(state.notice, null);
assert.match(setup.captureCharFrame(), /Messages is not available[\s\S]*Cannot read the Messages database\./);
state = { ...state, connection: "online", unavailable: null, selected: secondChat, input: { kind: "search", returnTo: { kind: "transcript", chatGuid: secondChat } } };
for (const listener of listeners) listener();

setup.resize(50, 16);
session.act({ type: "input", input: { kind: "help", returnTo: { kind: "list" } } });
await setup.flush();
frame = setup.captureCharFrame();
saveFrame("narrow-help-50x16.txt", frame);
assert.match(frame, /Keyboard shortcuts/);
assert.match(frame, /q\s+quit/);
session.act({ type: "input", input: { kind: "new-chat", addresses: "", text: "", service: "iMessage", field: "addresses", busy: false, error: null } });
await setup.flush();
frame = setup.captureCharFrame();
saveFrame("narrow-new-chat-50x16.txt", frame);
assert.match(frame, /New conversation/);
assert.match(frame, /Ctrl\+S send/);

setup.resize(38, 12);
session.act({ type: "input", input: { kind: "help", returnTo: { kind: "list" } } });
await setup.flush();
frame = setup.captureCharFrame();
saveFrame("minimum-help-38x12.txt", frame);
assert.match(frame, /Keyboard shortcuts/);
session.act({ type: "input", input: { kind: "new-chat", addresses: "", text: "", service: "iMessage", field: "addresses", busy: false, error: null } });
await setup.flush();
frame = setup.captureCharFrame();
saveFrame("minimum-new-chat-38x12.txt", frame);
assert.match(frame, /New conversation/);
assert.match(frame, /Recipients/);

session.act({ type: "input", input: { kind: "list" } });
for (const [width, height, expected] of [[80, 24, "Messages"], [50, 16, "Messages"], [32, 10, "Terminal too small"]] as const) {
  setup.resize(width, height);
  await setup.flush();
  frame = setup.captureCharFrame();
  saveFrame(`frame-${width}x${height}.txt`, frame);
  assert.match(frame, new RegExp(expected));
}

state = { ...state, input: { kind: "composer", chatGuid: firstChat } };
for (const listener of listeners) listener();
setup.resize(32, 10);
await setup.flush();
setup.mockInput.pressKey("q");
await setup.flush();
assert.equal(intents.at(-1)?.type, "quit");
setup.mockInput.pressKey("c", { ctrl: true });
await setup.flush();
assert.equal(intents.at(-1)?.type, "quit");
assert.equal(subscribeCalls, 1);
assert.equal(peakListeners, 1);
app.unmount();
app.cleanup();
await delay(10);
assert.equal(listeners.size, 0);
if (process.env.TUIMSG_UI_VERIFY_FORCE_FAIL === "1") assert.fail("forced verifier failure");
console.log("ui verification passed: Ink frames, input ownership, drafts, modal focus, one mount, one listener");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveFrame(name: string, frame: string): void {
  mkdirSync(".audit/ui", { recursive: true });
  writeFileSync(`.audit/ui/${name}`, frame);
}

async function waitForImage(): Promise<void> {
  for (let elapsed = 0; elapsed < 3000; elapsed += 65) {
    if (setup.captureCharFrame().includes("▄")) return;
    await setup.flush();
  }
  assert.fail("expected decoded image pixels in the Ink frame");
}
