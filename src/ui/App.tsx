import { isMouseSequence, MouseProvider } from "./mouse.tsx";
import { Box, Text, useInput, useWindowSize, type Key } from "ink";
import { ImageViewer } from "./ImagePreview.tsx";
import { isImageAttachment } from "../attachments.ts";
import { useMemo, useSyncExternalStore } from "react";
import type { AppState, Attachment, Chat, InputMode, Message, Pane, Reaction, Session } from "../domain/model.ts";
import { bridgeAvailable, draftFor } from "../domain/model.ts";
import type { MessageGuid } from "../domain/ids.ts";
import { sortedChats } from "../domain/view.ts";
import { Composer, composerHeight } from "./Composer.tsx";
import { Help } from "./Help.tsx";
import { List } from "./List.tsx";
import { AttachmentModal, ConfirmModal, NewChatModal, ReactionModal, SearchModal } from "./Modals.tsx";
import { Transcript } from "./Transcript.tsx";
import { colors, currentTheme, setTheme, useTheme } from "./theme.ts";
import { firstLink } from "../domain/links.ts";
import { cleanText } from "../domain/text.ts";

const REACTIONS: Reaction[] = ["love", "like", "dislike", "laugh", "emphasize", "question"];
const LANE_WIDTH = 84;
export type AppProps = { session: Session };

export function App(props: AppProps) {
  return <MouseProvider><AppContent {...props} /></MouseProvider>;
}

function AppContent({ session }: AppProps) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useTheme();
  const { columns, rows } = useWindowSize();
  const size = { width: columns, height: rows };
  const chats = useMemo(() => sortedChats(state.chats, state.search), [state.chats, state.search]);
  const selected = state.selected ? state.chats.get(state.selected) : undefined;
  const messages = state.selected ? state.messages.get(state.selected) ?? [] : [];
  const input = state.input;
  const pane = paneFor(input);
  const narrow = size.width < 72;
  const tiny = size.width < 38 || size.height < 12;

  useInput((input, key) => {
    // Keys go against the live state, which a key earlier in the same read may have changed.
    const route = (text: string, event: Key) => {
      const live = session.getSnapshot();
      routeKey(keyEvent(text, event), { ...(live === state ? { state, chats, selected, messages } : derive(live)), session, tiny });
    };
    const characters = Array.from(input);
    // Ink hands over a sequence it could not name without its escape ("[<65;9;4M" for the
    // wheel); those are never keys to take apart.
    const plain = !key.ctrl && !key.meta && !key.escape && !key.return && !key.tab && !input.startsWith("[") && !isMouseSequence(input);
    if (characters.length < 2 || !plain || textField(session.getSnapshot().input)) { route(input, key); return; }
    // Over SSH, keys typed quickly can arrive in one read, which Ink hands over as one string.
    // Outside a field each is a command; once one opens a field, the rest is typed into it.
    for (let index = 0; index < characters.length; index++) {
      const mode = session.getSnapshot().input;
      if (textField(mode)) { typeInto(mode, characters.slice(index).join(""), session); return; }
      const character = characters[index]!;
      route(character, { ...key, shift: character !== character.toLowerCase() });
    }
  });

  if (tiny) {
    return (
      <Box width={size.width} height={size.height} justifyContent="center" alignItems="center" backgroundColor={colors.canvas}>
        <Box borderStyle="round" borderBackgroundColor={colors.canvas} borderColor={colors.warning} padding={1} flexDirection="column">
          <Text><Text bold color={colors.text}>Terminal too small</Text></Text>
          <Text><Text color={colors.secondary}>Resize to at least 38 × 12</Text></Text>
          <Text><Text color={colors.secondary}>Current size {size.width} × {size.height} · q quits</Text></Text>
        </Box>
      </Box>
    );
  }

  const showList = !narrow || pane.kind === "list" || input.kind === "search" || input.kind === "new-chat";
  const showConversation = !narrow || !showList;
  const listWidth = narrow ? size.width : Math.min(34, Math.max(27, Math.floor(size.width * 0.28)));
  const conversationWidth = narrow ? size.width : size.width - listWidth;
  // The conversation reads as one column of about 80 characters, the length a line of text
  // is easiest to follow at; wider terminals leave the space around it.
  const laneWidth = Math.min(LANE_WIDTH, conversationWidth);
  // The key hints end where the conversation does, under the composer, not at the far edge.
  const laneRight = narrow ? size.width : listWidth + Math.round((conversationWidth - laneWidth) / 2) + laneWidth;
  // A long draft grows the composer to about a third of the screen, then scrolls.
  const composerRows = Math.max(3, Math.min(10, Math.floor(size.height / 3)));
  const history = selected ? state.history.get(selected.guid) ?? { kind: "unloaded" as const } : { kind: "unloaded" as const };
  const cursor = selected ? state.messageCursor.get(selected.guid) ?? null : null;

  return (
    <Box flexDirection="column" width={size.width} height={size.height} backgroundColor={colors.canvas}>
      <Box flexDirection="row" height={size.height - 1} flexShrink={0}>
        {showList ? <List chats={chats} selected={state.selected} cursor={state.listCursor} search={state.search}
          focused={input.kind === "list"} width={listWidth} height={size.height - 1} status={state.chatsStatus}
          onMove={(delta) => session.act({ type: "move-list", delta })}
          onOpen={(chatGuid) => { if (input.kind === "list" || input.kind === "transcript" || input.kind === "composer") session.act({ type: "open-chat", chatGuid }); }} /> : null}
        {showConversation ? (
          <Box width={conversationWidth} alignItems="center" flexDirection="column">
            <Box width={laneWidth} flexDirection="column" height={size.height - 1}>
              {selected ? (
                <>
                  <Transcript chatGuid={selected.guid} title={selected.title} subtitle={chatSubtitle(selected)} group={selected.kind === "group"} messages={messages}
                    height={size.height - 1 - composerHeight(draftFor(state, selected.guid), input.kind === "composer", laneWidth, composerRows)} width={laneWidth}
                    typing={Boolean(state.typing.get(selected.guid))} focused={input.kind === "transcript"}
                    cursor={cursor} history={history} readError={state.readPending.get(selected.guid) ?? null}
                    onSelect={(messageGuid) => { if (input.kind === "list" || input.kind === "transcript" || input.kind === "composer") session.act({ type: "select-message", chatGuid: selected.guid, messageGuid }); }}
                    onHistory={(mode) => session.act({ type: "load-history", chatGuid: selected.guid, mode })}
                    loadAttachment={input.kind === "list" || input.kind === "transcript" || input.kind === "composer" ? session.loadAttachment : undefined}
                    onViewAttachment={(attachment) => { if (input.kind === "list" || input.kind === "transcript" || input.kind === "composer") viewAttachment(session, attachment, { kind: "transcript", chatGuid: selected.guid }); }}
                    onRetryRead={() => session.act({ type: "retry-read", chatGuid: selected.guid })} />
                  <Composer key={selected.guid} draft={draftFor(state, selected.guid)} service={selected.service} focused={input.kind === "composer"} width={laneWidth} maxRows={composerRows}
                    replyingTo={replyLabel(draftFor(state, selected.guid).replyTo, messages)}
                    onChange={(text) => session.act({ type: "draft-set", chatGuid: selected.guid, text })}
                    onSubmit={() => session.act({ type: "send", chatGuid: selected.guid })}
                    onEscape={() => session.act({ type: "input", input: { kind: "transcript", chatGuid: selected.guid } })} />
                </>
              ) : state.connection === "no-access" && state.unavailable ? (
                <Box flexGrow={1} justifyContent="center" alignItems="center" paddingX={2}>
                  <Box flexDirection="column" width={Math.min(64, laneWidth - 4)}>
                    <Text><Text bold color={colors.text}>Messages is not available</Text></Text>
                    <Text><Text color={colors.secondary}>{state.unavailable}</Text></Text>
                    <Text><Text color={colors.subtle}>Shift+R retries · q quits</Text></Text>
                  </Box>
                </Box>
              ) : (
                <Box flexGrow={1} justifyContent="center" alignItems="center">
                  <Box flexDirection="column" alignItems="center">
                    <Text><Text bold color={colors.text}>Choose a conversation</Text></Text>
                    <Text><Text color={colors.secondary}>Enter opens the highlighted chat · n starts a new one</Text></Text>
                  </Box>
                </Box>
              )}
            </Box>
          </Box>
        ) : null}
      </Box>
      <StatusBar state={state} narrow={narrow} width={size.width} inset={size.width - laneRight} selected={selected ? selectedMessage(state.messageCursor.get(selected.guid), messages) : undefined} />
      <Overlay input={input} state={state} messages={messages} session={session} width={size.width} height={size.height} />
    </Box>
  );
}

type RouteContext = {
  state: ReturnType<Session["getSnapshot"]>;
  chats: ReturnType<typeof sortedChats>;
  selected: Chat | undefined;
  messages: Message[];
  session: Session;
  tiny: boolean;
};

function derive(state: AppState): Pick<RouteContext, "state" | "chats" | "selected" | "messages"> {
  return {
    state, chats: sortedChats(state.chats, state.search),
    selected: state.selected ? state.chats.get(state.selected) : undefined,
    messages: state.selected ? state.messages.get(state.selected) ?? [] : [],
  };
}

const textField = (mode: InputMode) => mode.kind === "composer" || mode.kind === "search" || mode.kind === "new-chat";

// Text that arrived in the read that opened its field, which the field's own input was not
// there yet to take. An Enter at its end is dropped rather than sending: the text shows, and
// the next Enter sends it.
function typeInto(mode: InputMode, text: string, session: Session): void {
  const typed = cleanText(text.replace(/\r$/, ""));
  const line = typed.replace(/\n/g, "");
  if (!typed) return;
  const state = session.getSnapshot();
  if (mode.kind === "composer") session.act({ type: "draft-set", chatGuid: mode.chatGuid, text: draftFor(state, mode.chatGuid).text + typed });
  else if (mode.kind === "search") session.act({ type: "search-set", text: state.search + line });
  else if (mode.kind === "new-chat") session.act({ type: "input", input: { ...mode, [mode.field]: mode[mode.field] + (mode.field === "text" ? typed : line) } });
}

function routeKey(key: KeyEvent, context: RouteContext): void {
  const { state, session } = context;
  const input = state.input;
  // A notice gives way to the key hints at the next key, if its time is not already up. The
  // live state is checked, since a notice can land after the frame this key was read against.
  if (session.getSnapshot().notice) session.act({ type: "notice", notice: null });
  if (key.ctrl && key.name === "c") {
    session.act({ type: "quit" });
    return;
  }
  if (context.tiny && key.name === "q") {
    session.act({ type: "quit" });
    return;
  }
  if (input.kind === "image") {
    if (key.name === "escape" || key.name === "q") session.act({ type: "input", input: input.returnTo });
    else if (key.name === "o" || key.name === "s") session.act({ type: "attachment", attachment: input.attachment, action: key.name === "o" ? "open" : "save" });
    return;
  }
  if (input.kind === "help") {
    if (key.name === "escape" || key.sequence === "?") {
      session.act({ type: "input", input: input.returnTo });
    }
    return;
  }
  if (input.kind === "search") {
    if (key.name === "escape") { session.act({ type: "input", input: input.returnTo }); }
    return;
  }
  if (input.kind === "new-chat") {
    if (key.name === "escape") { session.act({ type: "input", input: { kind: "list" } }); }
    else if (key.name === "tab") { session.act({ type: "input", input: { ...input, field: input.field === "addresses" ? "text" : "addresses" } }); }
    else if (key.ctrl && key.name === "t") { session.act({ type: "input", input: { ...input, service: input.service === "iMessage" ? "SMS" : "iMessage" } }); }
    else if (key.ctrl && key.name === "s") { submitNewChat(input, session); }
    return;
  }
  if (input.kind === "tapback") {
    const delta = key.name === "left" || key.name === "k" ? -1 : key.name === "right" || key.name === "j" ? 1 : 0;
    const numeric = /^[1-6]$/.test(key.sequence) ? Number(key.sequence) - 1 : -1;
    const choice = Number.isInteger(numeric) && numeric >= 0 && numeric < REACTIONS.length ? numeric : (input.choice + delta + REACTIONS.length) % REACTIONS.length;
    if (choice !== input.choice) session.act({ type: "input", input: { ...input, choice } });
    if (key.name === "return" || key.name === "x") {
      session.act({ type: "react", chatGuid: input.chatGuid, messageGuid: input.messageGuid, reaction: REACTIONS[choice]!, remove: key.name === "x" });
      session.act({ type: "input", input: { kind: "transcript", chatGuid: input.chatGuid } });
    } else if (key.name === "escape") session.act({ type: "input", input: { kind: "transcript", chatGuid: input.chatGuid } });
    return;
  }
  if (input.kind === "attachments") {
    const attachments = attachmentsFor(context.messages, input.messageGuid);
    const delta = key.name === "up" || key.name === "k" ? -1 : key.name === "down" || key.name === "j" ? 1 : 0;
    const choice = attachments.length ? (input.choice + delta + attachments.length) % attachments.length : 0;
    if (choice !== input.choice) session.act({ type: "input", input: { ...input, choice } });
    const attachment = attachments[choice];
    if (attachment && (key.name === "v" || key.name === "return")) viewAttachment(session, attachment, { kind: "transcript", chatGuid: input.chatGuid });
    if (attachment && (key.name === "o" || key.name === "s")) session.act({ type: "attachment", attachment, action: key.name === "o" ? "open" : "save" });
    if (key.name === "escape") session.act({ type: "input", input: { kind: "transcript", chatGuid: input.chatGuid } });
    return;
  }
  if (input.kind === "retry-confirm") {
    if (key.name === "y") session.act({ type: "retry-send", tempGuid: input.tempGuid, confirmed: true });
    if (key.name === "y" || key.name === "n" || key.name === "escape") session.act({ type: "input", input: input.returnTo });
    return;
  }

  if (input.kind !== "composer" && (key.sequence === "?" || key.shift && key.name === "/")) {
    session.act({ type: "input", input: { kind: "help", returnTo: input } });
    return;
  }
  if (input.kind !== "composer" && key.name === "q") { session.act({ type: "quit" }); return; }
  if (input.kind !== "composer" && key.name === "l" && key.shift) {
    const theme = currentTheme() === "dark" ? "light" : "dark";
    setTheme(theme);
    session.act({ type: "notice", notice: { kind: "info", text: theme === "light" ? "Light mode · Shift+L for dark" : "Dark mode · Shift+L for light" } });
    return;
  }
  if (key.name === "tab") { cyclePane(input, state.selected, session); return; }
  if (input.kind !== "composer" && key.name === "/") {
    session.act({ type: "input", input: { kind: "search", returnTo: input } }); return;
  }
  if (input.kind !== "composer" && key.name === "n") {
    session.act({ type: "input", input: { kind: "new-chat", addresses: "", text: "", service: "iMessage", field: "addresses", busy: false, error: null } }); return;
  }
  if (input.kind === "list") routeList(key, context);
  else if (input.kind === "transcript") routeTranscript(key, context);
  else if (input.kind === "composer" && key.name === "escape") session.act({ type: "input", input: { kind: "transcript", chatGuid: input.chatGuid } });
}

function routeList(key: KeyEvent, context: RouteContext): boolean {
  const { state, session, chats } = context;
  if (key.name === "j" || key.name === "down") session.act({ type: "move-list", delta: 1 });
  else if (key.name === "k" || key.name === "up") session.act({ type: "move-list", delta: -1 });
  else if (key.name === "return") {
    const chat = chats.find((item) => item.guid === state.listCursor) ?? chats[0];
    if (chat) session.act({ type: "open-chat", chatGuid: chat.guid });
  } else if (key.name === "r" && (key.shift || state.chatsStatus === "error")) session.act({ type: "refresh" });
  else return false;
  return true;
}

function routeTranscript(key: KeyEvent, context: RouteContext): boolean {
  const { state, session, selected, messages } = context;
  if (!selected) return false;
  const chatGuid = selected.guid;
  const message = selectedMessage(state.messageCursor.get(chatGuid), messages);
  const link = message?.kind === "text" ? firstLink(message.body) : undefined;
  if (key.name === "j" || key.name === "down") session.act({ type: "move-message", chatGuid, delta: 1 });
  else if (key.name === "k" || key.name === "up") session.act({ type: "move-message", chatGuid, delta: -1 });
  else if (key.name === "escape") session.act({ type: "input", input: { kind: "list" } });
  else if (key.name === "i" || key.name === "return") session.act({ type: "input", input: { kind: "composer", chatGuid } });
  else if (key.name === "g") session.act({ type: "load-history", chatGuid, mode: "older" });
  else if (key.name === "r" && key.shift && state.history.get(chatGuid)?.kind === "error") {
    const history = state.history.get(chatGuid);
    if (history?.kind === "error") session.act({ type: "load-history", chatGuid, mode: history.mode });
  }
  else if ((key.name === "r" || key.name === "t") && message && !bridgeAvailable(state.capabilities)) {
    session.act({ type: "notice", notice: { kind: "error", text: `${key.name === "r" ? "Replies" : "Reactions"} need the imsg bridge (imsg launch).` } });
  } else if (key.name === "r" && message) {
    session.act({ type: "reply", chatGuid, messageGuid: message.guid });
    session.act({ type: "input", input: { kind: "composer", chatGuid } });
  } else if (key.name === "y" && message?.kind === "text") session.act({ type: "copy", text: message.body });
  else if (key.name === "t" && message) session.act({ type: "input", input: { kind: "tapback", chatGuid, messageGuid: message.guid, choice: 0 } });
  else if (key.name === "v" && message?.kind === "text") {
    const attachment = message.attachments.find(isImageAttachment);
    if (attachment) viewAttachment(session, attachment, { kind: "transcript", chatGuid });
  }
  else if (key.name === "o" && link) session.act({ type: "open-link", url: link });
  else if ((key.name === "o" || key.name === "s") && message?.kind === "text" && message.attachments.length) {
    const attachment = message.attachments.find(isImageAttachment) ?? message.attachments[0]!;
    session.act({ type: "attachment", attachment, action: key.name === "o" ? "open" : "save" });
  }
  else if (key.name === "a" && message?.kind === "text" && message.attachments.length) session.act({ type: "input", input: { kind: "attachments", chatGuid, messageGuid: message.guid, choice: 0 } });
  else if (key.name === "!" && message?.kind === "text" && (message.status === "failed" || message.status === "uncertain")) {
    session.act({ type: "input", input: { kind: "retry-confirm", tempGuid: message.tempGuid ?? message.guid, returnTo: { kind: "transcript", chatGuid } } });
  } else if (key.name === "m" && state.readPending.get(chatGuid)) session.act({ type: "retry-read", chatGuid });
  else return false;
  return true;
}

function cyclePane(input: Pane, selected: ReturnType<Session["getSnapshot"]>["selected"], session: Session): void {
  if (!selected) { session.act({ type: "input", input: { kind: "list" } }); return; }
  const next: Pane = input.kind === "list" ? { kind: "transcript", chatGuid: selected }
    : input.kind === "transcript" ? { kind: "composer", chatGuid: selected } : { kind: "list" };
  session.act({ type: "input", input: next });
}

function selectedMessage(cursor: MessageGuid | undefined, messages: RouteContext["messages"]) {
  const selectable = messages.filter((message) => message.kind !== "tapback");
  return selectable.find((message) => message.guid === cursor) ?? selectable.at(-1);
}

function attachmentsFor(messages: RouteContext["messages"], guid: MessageGuid): Attachment[] {
  const message = messages.find((item) => item.guid === guid);
  return message?.kind === "text" ? message.attachments : [];
}

function submitNewChat(input: Extract<InputMode, { kind: "new-chat" }>, session: Session): void {
  if (input.busy || !input.addresses.trim() || !input.text.trim()) return;
  session.act({ type: "create-chat", addresses: input.addresses, text: input.text, service: input.service });
}

function paneFor(input: InputMode): Pane {
  if (input.kind === "help" || input.kind === "search" || input.kind === "image") return input.returnTo;
  if (input.kind === "tapback" || input.kind === "attachments") return { kind: "transcript", chatGuid: input.chatGuid };
  if (input.kind === "retry-confirm") return input.returnTo;
  if (input.kind === "new-chat") return { kind: "list" };
  return input;
}

const CONNECTION_LABELS = { connecting: "starting imsg", online: "online", offline: "imsg stopped", "no-access": "no access" } as const;

// The keys that matter where the focus is, key bright and action quiet.
const HINTS: Record<string, [string, string][]> = {
  list: [["↵", "open"], ["/", "search"], ["n", "new"], ["?", "help"]],
  transcript: [["i", "write"], ["r", "reply"], ["t", "react"], ["y", "copy"], ["?", "help"]],
  composer: [["↵", "send"], ["^J", "new line"], ["esc", "done"]],
  image: [["o", "open"], ["s", "save"], ["esc", "close"]],
};

function StatusBar(props: { state: ReturnType<Session["getSnapshot"]>; narrow: boolean; width: number; inset: number; selected?: Message | undefined }) {
  const { connection, notice, input } = props.state;
  const connectionColor = connection === "online" ? colors.sms : connection === "no-access" ? colors.failed : colors.warning;
  const hints = [...(HINTS[input.kind] ?? [])];
  // What the selected message offers comes first.
  const message = props.selected?.kind === "text" ? props.selected : undefined;
  if (input.kind === "transcript" && message) {
    const offer: [string, string] | undefined = firstLink(message.body) ? ["o", "open link"] : message.attachments.some(isImageAttachment) ? ["v", "view"] : message.attachments.length ? ["o", "open"] : undefined;
    if (offer) hints.splice(1, 0, offer);
  }
  const room = Math.max(0, props.width - props.inset - 24);
  const shown: [string, string][] = [];
  let used = 0;
  for (const hint of props.narrow ? hints.slice(0, 3) : hints) {
    used += hint[0].length + hint[1].length + 3;
    if (used > room) break;
    shown.push(hint);
  }
  return (
    <Box height={1} paddingLeft={2} paddingRight={2 + props.inset} flexDirection="row" justifyContent="space-between" backgroundColor={colors.sidebar}>
      <Text wrap="truncate-end"><Text color={connectionColor}>●</Text><Text color={colors.subtle}> {CONNECTION_LABELS[connection]}{bridgeAvailable(props.state.capabilities) && !props.narrow ? " · bridge" : ""}</Text></Text>
      {notice
        ? <Text wrap="truncate-end" color={notice.kind === "error" ? colors.failed : colors.secondary}>{notice.text}</Text>
        : <Text wrap="truncate-end">{shown.map(([key, action], index) => <Text key={key}>{index ? "   " : ""}<Text color={colors.text}>{key}</Text><Text color={colors.subtle}> {action}</Text></Text>)}</Text>}
    </Box>
  );
}

function chatSubtitle(chat: Chat): { text: string; color: string } {
  const service = chat.service === "SMS" ? "SMS" : "iMessage";
  const color = chat.service === "SMS" ? colors.sms : colors.accent;
  return { text: chat.kind === "group" && chat.participants.length > 1 ? `${service} · ${chat.participants.length} people` : service, color };
}

function replyLabel(guid: MessageGuid | null, messages: Message[]): string | undefined {
  if (!guid) return undefined;
  const message = messages.find((item) => item.guid === guid);
  if (message?.kind !== "text") return "Replying";
  const body = message.body.replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim() || message.attachments[0]?.name || "a message";
  return `${message.isFromMe ? "You" : message.from.contact?.displayName ?? message.from.address}: ${body}`;
}

function Overlay(props: {
  input: InputMode; state: ReturnType<Session["getSnapshot"]>; messages: RouteContext["messages"];
  session: Session; width: number; height: number;
}) {
  const style = {
    position: "absolute" as const,
    left: 0,
    top: 0,
    width: Math.max(1, props.width),
    height: Math.max(1, props.height - 1),
    alignItems: "center" as const,
  };
  let content: React.ReactNode = null;
  if (props.input.kind === "image") content = <ImageViewer attachment={props.input.attachment} session={props.session} width={props.width - 4} height={props.height - 2} />;
  else if (props.input.kind === "help") content = <Help width={Math.min(52, props.width - 4)} height={Math.min(15, props.height - 1)} />;
  else if (props.input.kind === "search") content = <SearchModal value={props.state.search}
    onChange={(text) => props.session.act({ type: "search-set", text })}
    onClose={() => props.session.act({ type: "input", input: props.input.kind === "search" ? props.input.returnTo : { kind: "list" } })} />;
  else if (props.input.kind === "new-chat") content = <NewChatModal mode={props.input}
    bridge={bridgeAvailable(props.state.capabilities)}
    onChange={(input) => props.session.act({ type: "input", input })}
    onCancel={() => props.session.act({ type: "input", input: { kind: "list" } })}
    onSubmit={() => submitNewChat(props.input as Extract<InputMode, { kind: "new-chat" }>, props.session)} />;
  else if (props.input.kind === "tapback") content = <ReactionModal choice={props.input.choice} />;
  else if (props.input.kind === "attachments") content = <AttachmentModal attachments={attachmentsFor(props.messages, props.input.messageGuid)} choice={props.input.choice} />;
  else if (props.input.kind === "retry-confirm") content = <ConfirmModal />;
  return content ? <Box {...style} justifyContent="center" backgroundColor={colors.canvas}>{content}</Box> : null;
}

function viewAttachment(session: Session, attachment: Attachment, returnTo: Pane): void {
  if (isImageAttachment(attachment)) session.act({ type: "input", input: { kind: "image", attachment, returnTo } });
  else session.act({ type: "attachment", attachment, action: "open" });
}

type KeyEvent = { name: string; sequence: string; ctrl: boolean; shift: boolean };
function keyEvent(input: string, key: Key): KeyEvent {
  const name = key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right" : key.return ? "return" : key.escape ? "escape" : key.tab ? "tab" : input.length === 1 ? input.toLowerCase() : "";
  return { name, sequence: input, ctrl: key.ctrl, shift: key.shift };
}
