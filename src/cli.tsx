import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { startTransition } from "react";
import { BbClient, hydrate } from "./bb/rest.ts";
import { FakeBb } from "./bb/fake.ts";
import { connectBbSocket } from "./bb/socket.ts";
import { writeClipboard } from "./clipboard.ts";
import { loadConfig, parseArgs } from "./config.ts";
import { parseMessageGuid } from "./domain/ids.ts";
import { emptyState, type AppEvent, type AppState, type Chat } from "./domain/model.ts";
import { reduce } from "./domain/reduce.ts";
import { App } from "./ui/App.tsx";

const HELP = `imsg — Messages TUI over BlueBubbles

Usage:
  imsg              connect using ~/.config/imsg/config.json or IMSG_URL / IMSG_PASSWORD
  imsg --fake       demo data, no BlueBubbles required
  imsg --help

Copy uses OSC 52 so SSH sessions can write the local clipboard.
`;

type Session = {
  state: AppState
  client: BbClient
  fake: FakeBb | undefined
  paint: (state: AppState) => void
};

const sessionRef: { current: Session | null } = { current: null };

function dispatch(event: AppEvent): void {
  const session = sessionRef.current;
  if (!session) return;
  const background =
    event.type === "message-upserted" && event.message.chatGuid !== session.state.selected;
  const apply = () => {
    session.state = reduce(session.state, event);
    session.paint(session.state);
  };
  if (background) startTransition(apply);
  else apply();
}

function handleSend(chat: Chat, text: string): void {
  const session = sessionRef.current;
  if (!session) return;
  void sendMessage(session.client, chat, text, session.fake);
}

function handleYank(text: string): void {
  writeClipboard(text);
  dispatch({ type: "yank-done" });
}

function paintState(state: AppState) {
  return <App state={state} dispatch={dispatch} onSend={handleSend} onYank={handleYank} />;
}

async function sendMessage(
  client: BbClient,
  chat: Chat,
  text: string,
  fake: FakeBb | undefined,
): Promise<void> {
  const tempGuid = parseMessageGuid(crypto.randomUUID());
  dispatch({ type: "send-requested", chatGuid: chat.guid, text, tempGuid });
  try {
    const data = await client.sendText({
      chatGuid: chat.guid,
      message: text,
      tempGuid,
      method: fake ? "apple-script" : "private-api",
    });
    const guid =
      typeof data === "object" && data !== null && "guid" in data && typeof data.guid === "string"
        ? data.guid
        : tempGuid;
    dispatch({ type: "send-acked", tempGuid, guid: parseMessageGuid(guid) });
  } catch {
    dispatch({ type: "send-failed", tempGuid });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write("tuimsg 0.1.0\n");
    return;
  }

  let fake: FakeBb | undefined;
  let url: string;
  let password: string;
  if (args.fake) {
    fake = new FakeBb();
    await fake.listen(0);
    url = fake.url;
    password = fake.password;
  } else {
    const config = await loadConfig();
    if (!config) {
      process.stderr.write(
        "No config. Set IMSG_URL and IMSG_PASSWORD, write ~/.config/imsg/config.json, or run imsg --fake.\n",
      );
      process.exitCode = 1;
      return;
    }
    url = config.url;
    password = config.password;
  }

  const client = new BbClient({ url, password });
  sessionRef.current = {
    state: emptyState(),
    client,
    fake,
    paint: () => undefined,
  };

  try {
    const { online, info, chats } = await hydrate(client);
    dispatch({ type: "connection", connection: online ? "online" : "offline" });
    dispatch({ type: "capabilities", capabilities: info });
    dispatch({ type: "chats-loaded", chats });
    const addresses = chats.flatMap((c) => c.participants.map((p) => p.address));
    const contacts = await client.queryContacts(addresses);
    dispatch({ type: "contacts-loaded", contacts });
    const first = chats[0];
    if (first) {
      const messages = await client.listMessages(first.guid);
      dispatch({ type: "select-chat", chatGuid: first.guid });
      dispatch({ type: "messages-loaded", chatGuid: first.guid, messages });
    }
  } catch (err) {
    dispatch({ type: "connection", connection: "auth-failed" });
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    if (!args.fake) {
      process.exitCode = 1;
      await fake?.close();
      return;
    }
  }

  const socket = connectBbSocket({ url, password, handlers: { dispatch } });
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: "#000000",
  });
  const root = createRoot(renderer);
  const session = sessionRef.current;
  if (!session) return;
  session.paint = (next) => root.render(paintState(next));
  root.render(paintState(session.state));

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" && session.state.focus === "list" && session.state.overlay === "none") {
      socket.close();
      root.unmount();
      renderer.destroy();
      void fake?.close();
    }
  });
}

await main();
