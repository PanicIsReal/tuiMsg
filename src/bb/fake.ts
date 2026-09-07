import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Server as IoServer } from "socket.io";
import type { AddressInfo } from "node:net";

export type FakeMessage = {
  guid: string;
  chatGuid: string;
  text: string;
  isFromMe: boolean;
  dateCreated: number;
  dateDelivered?: number;
  dateRead?: number;
  handle?: { address: string; service: string };
  tempGuid?: string;
  itemType?: number;
  groupActionType?: number;
  associatedMessageType?: number;
  associatedMessageGuid?: string;
  attachments?: unknown[];
  chats?: { guid: string }[];
};

export type FakeChat = {
  guid: string;
  style: number;
  displayName: string;
  unreadCount: number;
  participants: { address: string; service: string }[];
  lastMessage?: FakeMessage;
};

export type FakeContact = {
  displayName: string;
  phoneNumbers?: { address: string }[];
  emails?: { address: string }[];
};

export type FakeOptions = {
  helperConnected?: boolean;
  privateApi?: boolean;
  chats?: FakeChat[];
  messages?: Record<string, FakeMessage[]>;
  contacts?: FakeContact[];
  attachments?: Record<string, Uint8Array>;
  failures?: Record<string, { status: number; message: string }>;
  delays?: Record<string, number>;
};

export type FakeRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
};

function json(
  res: ServerResponse,
  status: number,
  data: unknown,
  message = "Success",
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status, message, data }));
}

function jsonPage(
  res: ServerResponse,
  data: unknown,
  metadata: Record<string, number>,
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status: 200, message: "Success", data, metadata }));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function passwordOf(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  return url.searchParams.get("password") ?? url.searchParams.get("guid");
}

export class FakeBb {
  helperConnected: boolean;
  privateApi: boolean;
  chats: FakeChat[];
  messages: Map<string, FakeMessage[]>;
  contacts: FakeContact[];
  sent: FakeMessage[] = [];
  requests: FakeRequest[] = [];
  attachments: Map<string, Uint8Array>;
  failures: Map<string, { status: number; message: string }>;
  delays: Map<string, number>;
  closed = false;
  password = "test-password";
  private server = createServer((req, res) => {
    void this.route(req, res);
  });
  private io = new IoServer(this.server, { cors: { origin: "*" } });
  private sequence = 0;

  constructor(options: FakeOptions = {}) {
    this.helperConnected = options.helperConnected ?? true;
    this.privateApi = options.privateApi ?? true;
    this.chats = options.chats ?? defaultChats();
    this.messages = new Map(
      Object.entries(options.messages ?? defaultMessages()),
    );
    this.contacts = options.contacts ?? defaultContacts();
    this.attachments = new Map(Object.entries(options.attachments ?? {}));
    this.failures = new Map(Object.entries(options.failures ?? {}));
    this.delays = new Map(Object.entries(options.delays ?? {}));
    this.io.use((socket, next) => {
      const pwd = String(
        socket.handshake.query.password ?? socket.handshake.query.guid ?? "",
      );
      if (pwd !== this.password) {
        next(new Error("unauthorized"));
        return;
      }
      next();
    });
  }

  get url(): string {
    const addr = this.server.address() as AddressInfo | null;
    if (!addr) throw new Error("fake server not listening");
    return `http://127.0.0.1:${addr.port}`;
  }

  async listen(port = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", resolve);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    this.closed = true;
  }

  emit(event: string, data: unknown): void {
    this.io.emit(event, data);
  }

  emitSequence(events: Array<{ event: string; data: unknown }>): void {
    for (const item of events) this.emit(item.event, item.data);
  }

  private nextGuid(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (passwordOf(req) !== this.password) {
      json(res, 401, null, "Unauthorized");
      return;
    }
    const path = url.pathname;
    const method = req.method ?? "GET";
    const body = method === "GET" ? undefined : await readBody(req);
    this.requests.push({
      method,
      path,
      query: new URLSearchParams(url.searchParams),
      ...(body === undefined ? {} : { body }),
    });
    const failure = this.failures.get(`${method} ${path}`);
    const delay = this.delays.get(`${method} ${path}`);
    if (delay !== undefined)
      await new Promise((resolve) => setTimeout(resolve, delay));
    if (failure) {
      json(res, failure.status, null, failure.message);
      return;
    }
    const privatePath =
      path.endsWith("/read") ||
      path.endsWith("/typing") ||
      path === "/api/v1/message/react";
    if (privatePath && !(this.privateApi && this.helperConnected)) {
      json(res, 501, null, "Private API unavailable");
      return;
    }

    if (method === "GET" && path === "/api/v1/ping") {
      json(res, 200, "pong", "Ping received!");
      return;
    }
    if (method === "GET" && path === "/api/v1/server/info") {
      json(res, 200, {
        private_api: this.privateApi,
        helper_connected: this.helperConnected,
        server_version: "fake-1.0.0",
      });
      return;
    }
    if (method === "POST" && path === "/api/v1/chat/query") {
      const input = body as Record<string, unknown>;
      const offset = Number(input.offset ?? 0);
      const limit = Number(input.limit ?? 1000);
      const guid = typeof input.guid === "string" ? input.guid : undefined;
      const rows = this.chats
        .filter((chat) => !guid || chat.guid === guid)
        .sort(
          (a, b) =>
            (b.lastMessage?.dateCreated ?? 0) -
            (a.lastMessage?.dateCreated ?? 0),
        );
      jsonPage(res, rows.slice(offset, offset + limit), {
        count: Math.min(limit, Math.max(0, rows.length - offset)),
        total: rows.length,
        offset,
        limit,
      });
      return;
    }
    if (
      method === "GET" &&
      path.startsWith("/api/v1/chat/") &&
      path.endsWith("/message")
    ) {
      const encoded = path.slice("/api/v1/chat/".length, -"/message".length);
      const guid = decodeURIComponent(encoded);
      const offset = Number(url.searchParams.get("offset") ?? 0),
        limit = Number(url.searchParams.get("limit") ?? 100),
        before = Number(
          url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
        );
      const rows = (this.messages.get(guid) ?? [])
        .filter((m) => m.dateCreated <= before)
        .sort(
          (a, b) =>
            b.dateCreated - a.dateCreated || b.guid.localeCompare(a.guid),
        );
      jsonPage(res, rows.slice(offset, offset + limit), {
        count: Math.min(limit, Math.max(0, rows.length - offset)),
        total: rows.length,
        offset,
        limit,
      });
      return;
    }
    if (method === "POST" && path === "/api/v1/message/query") {
      const input = body as Record<string, unknown>;
      const offset = Number(input.offset ?? 0),
        limit = Number(input.limit ?? 100),
        after = Number(input.after ?? 0),
        before = Number(input.before ?? Number.MAX_SAFE_INTEGER);
      const rows = [...this.messages.values()]
        .flat()
        .filter((m) => m.dateCreated >= after && m.dateCreated <= before)
        .sort(
          (a, b) =>
            a.dateCreated - b.dateCreated || a.guid.localeCompare(b.guid),
        );
      jsonPage(res, rows.slice(offset, offset + limit), {
        count: Math.min(limit, Math.max(0, rows.length - offset)),
        total: rows.length,
        offset,
        limit,
      });
      return;
    }
    if (method === "POST" && path === "/api/v1/message/text") {
      const input = body as Record<string, unknown>;
      const chatGuid = String(input.chatGuid ?? "");
      const message: FakeMessage = {
        guid: this.nextGuid("sent"),
        chatGuid,
        text: String(input.message ?? ""),
        isFromMe: true,
        dateCreated: Date.now(),
        dateDelivered: Date.now(),
        handle: { address: "me", service: "iMessage" },
        tempGuid: String(input.tempGuid ?? ""),
        chats: [{ guid: chatGuid }],
      };
      this.sent.push(message);
      const list = this.messages.get(chatGuid) ?? [];
      list.push(message);
      this.messages.set(chatGuid, list);
      const chat = this.chats.find((c) => c.guid === chatGuid);
      if (chat) chat.lastMessage = message;
      this.emit("new-message", message);
      json(res, 200, message, "Message sent!");
      return;
    }
    if (method === "POST" && path === "/api/v1/contact/query") {
      json(res, 200, this.contacts);
      return;
    }
    if (method === "POST" && path.endsWith("/read")) {
      const encoded = path.slice("/api/v1/chat/".length, -"/read".length);
      const guid = decodeURIComponent(encoded);
      const chat = this.chats.find((c) => c.guid === guid);
      if (chat) chat.unreadCount = 0;
      json(res, 200, true);
      return;
    }
    if (method === "POST" && path === "/api/v1/message/react") {
      const input = body as Record<string, unknown>;
      const reaction = String(input.reaction ?? "");
      const removed = reaction.startsWith("-");
      const message: FakeMessage = {
        guid: this.nextGuid("reaction"),
        chatGuid: String(input.chatGuid ?? ""),
        text: "",
        isFromMe: true,
        dateCreated: Date.now(),
        handle: { address: "me", service: "iMessage" },
        associatedMessageType:
          (removed ? 3000 : 2000) +
          ["love", "like", "dislike", "laugh", "emphasize", "question"].indexOf(
            reaction.replace(/^-/, ""),
          ),
        associatedMessageGuid: String(input.selectedMessageGuid ?? ""),
        chats: [{ guid: String(input.chatGuid ?? "") }],
      };
      json(res, 200, message);
      return;
    }
    if (method === "POST" && path.endsWith("/typing")) {
      json(res, 200, true);
      return;
    }
    if (method === "DELETE" && path.endsWith("/typing")) {
      json(res, 200, null);
      return;
    }
    if (method === "POST" && path === "/api/v1/chat/new") {
      const input = body as Record<string, unknown>;
      const addresses = input.addresses as string[];
      const guid = `${input.service ?? "iMessage"};+;${addresses.length > 1 ? `chat${this.chats.length}` : addresses[0]}`;
      const message: FakeMessage = {
        guid: this.nextGuid("created"),
        chatGuid: guid,
        text: String(input.message),
        isFromMe: true,
        dateCreated: Date.now(),
        handle: { address: "me", service: String(input.service) },
        tempGuid: String(input.tempGuid),
        chats: [{ guid }],
      };
      const chat: FakeChat = {
        guid,
        style: addresses.length > 1 ? 43 : 45,
        displayName: "",
        unreadCount: 0,
        participants: addresses.map((address) => ({
          address,
          service: String(input.service),
        })),
        lastMessage: message,
      };
      this.chats.unshift(chat);
      this.messages.set(guid, [message]);
      json(res, 200, { ...chat, messages: [message] });
      return;
    }
    const attachment = path.match(/^\/api\/v1\/attachment\/([^/]+)\/download$/);
    if (method === "GET" && attachment) {
      const bytes = this.attachments.get(
        decodeURIComponent(attachment[1] ?? ""),
      );
      if (!bytes) {
        json(res, 404, null, "Attachment not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.end(bytes);
      return;
    }
    json(res, 404, null, `no fake route ${method} ${path}`);
  }
}

const JANE = "iMessage;+;+15551230001";
const SAM = "SMS;+;+15551230002";
const RILEY = "iMessage;+;+15551230004";
const MIRA = "iMessage;+;+15551230005";
const WEEKEND = "iMessage;+;chat000111222";
const JORDAN = "iMessage;+;+15551230006";
const BOOK = "iMessage;+;chat000444555";

function textMessage(args: {
  guid: string;
  chatGuid: string;
  text: string;
  isFromMe: boolean;
  dateCreated: number;
  address: string;
  service: string;
  dateDelivered?: number;
}): FakeMessage {
  return {
    guid: args.guid,
    chatGuid: args.chatGuid,
    text: args.text,
    isFromMe: args.isFromMe,
    dateCreated: args.dateCreated,
    ...(args.dateDelivered === undefined
      ? {}
      : { dateDelivered: args.dateDelivered }),
    handle: { address: args.address, service: args.service },
    chats: [{ guid: args.chatGuid }],
  };
}

function defaultChats(): FakeChat[] {
  const now = Date.now();
  const messages = defaultMessagesAt(now);
  const last = (guid: string) => {
    const rows = messages[guid] ?? [];
    return rows
      .filter((m) => !m.associatedMessageType)
      .sort((a, b) => a.dateCreated - b.dateCreated)
      .at(-1);
  };
  return [
    {
      guid: JANE,
      style: 45,
      displayName: "",
      unreadCount: 2,
      participants: [{ address: "+15551230001", service: "iMessage" }],
      lastMessage: last(JANE),
    },
    {
      guid: SAM,
      style: 45,
      displayName: "",
      unreadCount: 0,
      participants: [{ address: "+15551230002", service: "SMS" }],
      lastMessage: last(SAM),
    },
    {
      guid: RILEY,
      style: 45,
      displayName: "",
      unreadCount: 1,
      participants: [{ address: "+15551230004", service: "iMessage" }],
      lastMessage: last(RILEY),
    },
    {
      guid: MIRA,
      style: 45,
      displayName: "",
      unreadCount: 0,
      participants: [{ address: "+15551230005", service: "iMessage" }],
      lastMessage: last(MIRA),
    },
    {
      guid: WEEKEND,
      style: 43,
      displayName: "Weekend",
      unreadCount: 0,
      participants: [
        { address: "+15551230001", service: "iMessage" },
        { address: "+15551230003", service: "iMessage" },
      ],
      lastMessage: last(WEEKEND),
    },
    {
      guid: JORDAN,
      style: 45,
      displayName: "",
      unreadCount: 0,
      participants: [{ address: "+15551230006", service: "iMessage" }],
      lastMessage: last(JORDAN),
    },
    {
      guid: BOOK,
      style: 43,
      displayName: "Book club",
      unreadCount: 0,
      participants: [
        { address: "+15551230007", service: "iMessage" },
        { address: "+15551230008", service: "iMessage" },
      ],
      lastMessage: last(BOOK),
    },
  ];
}

function defaultMessages(): Record<string, FakeMessage[]> {
  return defaultMessagesAt(Date.now());
}

function defaultMessagesAt(now: number): Record<string, FakeMessage[]> {
  return {
    [JANE]: [
      textMessage({
        guid: "jane-1",
        chatGuid: JANE,
        text: "Running late, sorry!",
        isFromMe: false,
        dateCreated: now - 25 * 60_000,
        address: "+15551230001",
        service: "iMessage",
      }),
      textMessage({
        guid: "jane-2",
        chatGuid: JANE,
        text: "All good. Grab the booth by the window?",
        isFromMe: true,
        dateCreated: now - 23 * 60_000,
        address: "me",
        service: "iMessage",
      }),
      textMessage({
        guid: "jane-3",
        chatGuid: JANE,
        text: "Already claimed it. They're out of the spicy dumplings though so I got the regular ones and an extra bao just in case.",
        isFromMe: false,
        dateCreated: now - 20 * 60_000,
        address: "+15551230001",
        service: "iMessage",
      }),
      {
        guid: "jane-tap-laugh",
        chatGuid: JANE,
        text: "",
        isFromMe: true,
        dateCreated: now - 19 * 60_000,
        handle: { address: "me", service: "iMessage" },
        associatedMessageType: 2003,
        associatedMessageGuid: "p:0/jane-3",
        chats: [{ guid: JANE }],
      },
      textMessage({
        guid: "jane-4",
        chatGuid: JANE,
        text: "Perfect. Leaving now.",
        isFromMe: true,
        dateCreated: now - 12 * 60_000,
        address: "me",
        service: "iMessage",
      }),
      textMessage({
        guid: "jane-5",
        chatGuid: JANE,
        text: "See you soon",
        isFromMe: false,
        dateCreated: now - 8 * 60_000,
        address: "+15551230001",
        service: "iMessage",
      }),
      textMessage({
        guid: "jane-6",
        chatGuid: JANE,
        text: "On the bike",
        isFromMe: true,
        dateCreated: now - 4 * 60_000,
        address: "me",
        service: "iMessage",
      }),
      textMessage({
        guid: "jane-7",
        chatGuid: JANE,
        text: "Side door is quieter",
        isFromMe: false,
        dateCreated: now - 2 * 60_000,
        address: "+15551230001",
        service: "iMessage",
      }),
      textMessage({
        guid: "jane-8",
        chatGuid: JANE,
        text: "I'll wave when I see you",
        isFromMe: false,
        dateCreated: now - 90_000,
        address: "+15551230001",
        service: "iMessage",
      }),
    ],
    [SAM]: [
      textMessage({
        guid: "sam-1",
        chatGuid: SAM,
        text: "Just pulled up",
        isFromMe: false,
        dateCreated: now - 20 * 60_000,
        address: "+15551230002",
        service: "SMS",
      }),
      textMessage({
        guid: "sam-2",
        chatGuid: SAM,
        text: "Parking is around back",
        isFromMe: true,
        dateCreated: now - 12 * 60_000,
        dateDelivered: now - 11 * 60_000,
        address: "me",
        service: "SMS",
      }),
      textMessage({
        guid: "sam-3",
        chatGuid: SAM,
        text: "Loading dock spots are open",
        isFromMe: true,
        dateCreated: now - 8 * 60_000,
        dateDelivered: now - 7 * 60_000,
        address: "me",
        service: "SMS",
      }),
    ],
    [RILEY]: [
      textMessage({
        guid: "riley-1",
        chatGuid: RILEY,
        text: "Deck's in the shared folder",
        isFromMe: true,
        dateCreated: now - 55 * 60_000,
        address: "me",
        service: "iMessage",
      }),
      textMessage({
        guid: "riley-2",
        chatGuid: RILEY,
        text: "Nice, chart three still has old numbers",
        isFromMe: false,
        dateCreated: now - 48 * 60_000,
        address: "+15551230004",
        service: "iMessage",
      }),
      textMessage({
        guid: "riley-3",
        chatGuid: RILEY,
        text: "Can you push a fix before standup?",
        isFromMe: false,
        dateCreated: now - 40 * 60_000,
        address: "+15551230004",
        service: "iMessage",
      }),
    ],
    [MIRA]: [
      textMessage({
        guid: "mira-1",
        chatGuid: MIRA,
        text: "Standup moved to 2",
        isFromMe: false,
        dateCreated: now - 3 * 60 * 60_000 - 20 * 60_000,
        address: "+15551230005",
        service: "iMessage",
      }),
      textMessage({
        guid: "mira-2",
        chatGuid: MIRA,
        text: "Thanks, blocked the time",
        isFromMe: true,
        dateCreated: now - 3 * 60 * 60_000,
        address: "me",
        service: "iMessage",
      }),
    ],
    [WEEKEND]: [
      textMessage({
        guid: "weekend-1",
        chatGuid: WEEKEND,
        text: "Still on for Saturday?",
        isFromMe: true,
        dateCreated: now - 86_400_000 - 3 * 60 * 60_000,
        address: "me",
        service: "iMessage",
      }),
      textMessage({
        guid: "weekend-2",
        chatGuid: WEEKEND,
        text: "Yep, 6 at my place",
        isFromMe: false,
        dateCreated: now - 86_400_000 - 2 * 60 * 60_000,
        address: "+15551230001",
        service: "iMessage",
      }),
      textMessage({
        guid: "weekend-3",
        chatGuid: WEEKEND,
        text: "I'll bring drinks",
        isFromMe: true,
        dateCreated: now - 86_400_000 - 60 * 60_000,
        address: "me",
        service: "iMessage",
      }),
      textMessage({
        guid: "weekend-4",
        chatGuid: WEEKEND,
        text: "Bring chips",
        isFromMe: false,
        dateCreated: now - 86_400_000,
        address: "+15551230003",
        service: "iMessage",
      }),
    ],
    [JORDAN]: [
      textMessage({
        guid: "jordan-1",
        chatGuid: JORDAN,
        text: "Final cut is up",
        isFromMe: false,
        dateCreated: now - 2 * 86_400_000 - 60 * 60_000,
        address: "+15551230006",
        service: "iMessage",
      }),
      textMessage({
        guid: "jordan-2",
        chatGuid: JORDAN,
        text: "Watching tonight",
        isFromMe: true,
        dateCreated: now - 2 * 86_400_000,
        address: "me",
        service: "iMessage",
      }),
    ],
    [BOOK]: [
      textMessage({
        guid: "book-1",
        chatGuid: BOOK,
        text: "Next up is the short one",
        isFromMe: false,
        dateCreated: now - 4 * 86_400_000 - 2 * 60 * 60_000,
        address: "+15551230007",
        service: "iMessage",
      }),
      textMessage({
        guid: "book-2",
        chatGuid: BOOK,
        text: "Finish by Thursday?",
        isFromMe: true,
        dateCreated: now - 4 * 86_400_000 - 60 * 60_000,
        address: "me",
        service: "iMessage",
      }),
      textMessage({
        guid: "book-3",
        chatGuid: BOOK,
        text: "Works for me",
        isFromMe: false,
        dateCreated: now - 4 * 86_400_000,
        address: "+15551230008",
        service: "iMessage",
      }),
    ],
  };
}

function defaultContacts(): FakeContact[] {
  return [
    { displayName: "Jane Doe", phoneNumbers: [{ address: "+15551230001" }] },
    { displayName: "Sam Park", phoneNumbers: [{ address: "+15551230002" }] },
    { displayName: "Alex Kim", phoneNumbers: [{ address: "+15551230003" }] },
    { displayName: "Riley Chen", phoneNumbers: [{ address: "+15551230004" }] },
    { displayName: "Mira Shah", phoneNumbers: [{ address: "+15551230005" }] },
    { displayName: "Jordan Blake", phoneNumbers: [{ address: "+15551230006" }] },
    { displayName: "Casey Ng", phoneNumbers: [{ address: "+15551230007" }] },
    { displayName: "Drew Ortiz", phoneNumbers: [{ address: "+15551230008" }] },
  ];
}
