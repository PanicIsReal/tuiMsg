import { encodeChatPath, type ChatGuid } from "../domain/ids.ts";
import {
  parseChatList,
  parseContactList,
  parseMessageList,
  parseServerInfo,
} from "../domain/parse.ts";
import type { Chat, Contact, Message } from "../domain/model.ts";

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type BbConfig = {
  url: string
  password: string
  fetch?: FetchFn
};

type Envelope = {
  status?: number
  message?: string
  data?: unknown
  error?: { type?: string; error?: string }
};

function joinUrl(base: string, path: string, password: string): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set("password", password);
  return url.toString();
}

function redact(url: string): string {
  return url.replace(/password=[^&]+/g, "password=REDACTED");
}

async function readEnvelope(res: Response): Promise<Envelope> {
  const text = await res.text();
  if (text.length === 0) return { status: res.status };
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    throw new Error(`invalid json from ${res.url}`);
  }
}

export class BbClient {
  readonly url: string;
  readonly password: string;
  helperConnected = false;
  private readonly fetchImpl: FetchFn;

  constructor(config: BbConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.password = config.password;
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request(method: string, path: string, body?: unknown): Promise<Envelope> {
    const href = joinUrl(this.url, path, this.password);
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(href, init);
    const envelope = await readEnvelope(res);
    if (!res.ok || (envelope.status !== undefined && envelope.status >= 400)) {
      const err = envelope.error?.error ?? envelope.message ?? res.statusText;
      throw new Error(`${method} ${redact(href)} failed: ${err}`);
    }
    return envelope;
  }

  async ping(): Promise<boolean> {
    const envelope = await this.request("GET", "/api/v1/ping");
    return envelope.status === 200 || envelope.data === "pong";
  }

  async serverInfo(): Promise<{ privateApi: boolean; helperConnected: boolean }> {
    const envelope = await this.request("GET", "/api/v1/server/info");
    const info = parseServerInfo(envelope);
    this.helperConnected = info.helperConnected;
    return info;
  }

  async listChats(): Promise<Chat[]> {
    const envelope = await this.request("POST", "/api/v1/chat/query", {
      limit: 200,
      offset: 0,
      with: ["lastMessage", "participants"],
      sort: "lastmessage",
    });
    return parseChatList(envelope);
  }

  async listMessages(chatGuid: ChatGuid): Promise<Message[]> {
    const envelope = await this.request(
      "GET",
      `/api/v1/chat/${encodeChatPath(chatGuid)}/message?limit=100&sort=ASC`,
    );
    return parseMessageList(envelope);
  }

  async sendText(args: {
    chatGuid: ChatGuid
    message: string
    tempGuid: string
    method?: "apple-script" | "private-api"
  }): Promise<unknown> {
    const wantPrivate = args.method === "private-api" && this.helperConnected;
    const envelope = await this.request("POST", "/api/v1/message/text", {
      chatGuid: args.chatGuid,
      message: args.message,
      tempGuid: args.tempGuid,
      method: wantPrivate ? "private-api" : "apple-script",
    });
    return envelope.data;
  }

  async queryContacts(addresses: string[]): Promise<Contact[]> {
    if (addresses.length === 0) return [];
    const envelope = await this.request("POST", "/api/v1/contact/query", { addresses });
    return parseContactList(envelope);
  }

  async markRead(chatGuid: ChatGuid): Promise<void> {
    if (!this.helperConnected) return;
    await this.request("POST", `/api/v1/chat/${encodeChatPath(chatGuid)}/read`, {});
  }

  async sendReaction(args: {
    chatGuid: ChatGuid
    messageGuid: string
    reaction: string
  }): Promise<void> {
    if (!this.helperConnected) return;
    await this.request("POST", "/api/v1/message/react", {
      chatGuid: args.chatGuid,
      selectedMessageGuid: args.messageGuid,
      reaction: args.reaction,
    });
  }

  async startTyping(chatGuid: ChatGuid): Promise<void> {
    if (!this.helperConnected) return;
    await this.request("POST", `/api/v1/chat/${encodeChatPath(chatGuid)}/typing`, {});
  }
}

export async function hydrate(client: BbClient): Promise<{
  online: boolean
  info: { privateApi: boolean; helperConnected: boolean }
  chats: Chat[]
}> {
  const [online, info, chats] = await Promise.all([
    client.ping(),
    client.serverInfo(),
    client.listChats(),
  ]);
  return { online, info, chats };
}
