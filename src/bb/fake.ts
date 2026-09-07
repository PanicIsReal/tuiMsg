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

function defaultChats(): FakeChat[] {
  const now = Date.now();
  return [
    {
      guid: "iMessage;+;+15551230001",
      style: 45,
      displayName: "",
      unreadCount: 2,
      participants: [{ address: "+15551230001", service: "iMessage" }],
      lastMessage: {
        guid: "m1",
        chatGuid: "iMessage;+;+15551230001",
        text: "You coming tonight?",
        isFromMe: false,
        dateCreated: now - 120_000,
        handle: { address: "+15551230001", service: "iMessage" },
      },
    },
    {
      guid: "SMS;+;+15551230002",
      style: 45,
      displayName: "",
      unreadCount: 0,
      participants: [{ address: "+15551230002", service: "SMS" }],
      lastMessage: {
        guid: "m2",
        chatGuid: "SMS;+;+15551230002",
        text: "Parking is around back",
        isFromMe: true,
        dateCreated: now - 3_600_000,
        handle: { address: "me", service: "SMS" },
      },
    },
    {
      guid: "iMessage;+;chat000111222",
      style: 43,
      displayName: "Weekend",
      unreadCount: 0,
      participants: [
        { address: "+15551230001", service: "iMessage" },
        { address: "+15551230003", service: "iMessage" },
      ],
      lastMessage: {
        guid: "m3",
        chatGuid: "iMessage;+;chat000111222",
        text: "Bring chips",
        isFromMe: false,
        dateCreated: now - 86_400_000,
        handle: { address: "+15551230003", service: "iMessage" },
      },
    },
  ];
}

function defaultMessages(): Record<string, FakeMessage[]> {
  const now = Date.now();
  return {
    "iMessage;+;+15551230001": [
      {
        guid: "m0",
        chatGuid: "iMessage;+;+15551230001",
        text: "Hey",
        isFromMe: false,
        dateCreated: now - 300_000,
        handle: { address: "+15551230001", service: "iMessage" },
        chats: [{ guid: "iMessage;+;+15551230001" }],
      },
      {
        guid: "m1",
        chatGuid: "iMessage;+;+15551230001",
        text: "You coming tonight?",
        isFromMe: false,
        dateCreated: now - 120_000,
        handle: { address: "+15551230001", service: "iMessage" },
        chats: [{ guid: "iMessage;+;+15551230001" }],
      },
    ],
    "SMS;+;+15551230002": [
      {
        guid: "m2",
        chatGuid: "SMS;+;+15551230002",
        text: "Parking is around back",
        isFromMe: true,
        dateCreated: now - 3_600_000,
        dateDelivered: now - 3_590_000,
        handle: { address: "me", service: "SMS" },
        chats: [{ guid: "SMS;+;+15551230002" }],
      },
    ],
    "iMessage;+;chat000111222": [
      {
        guid: "m3",
        chatGuid: "iMessage;+;chat000111222",
        text: "Bring chips",
        isFromMe: false,
        dateCreated: now - 86_400_000,
        handle: { address: "+15551230003", service: "iMessage" },
        chats: [{ guid: "iMessage;+;chat000111222" }],
      },
    ],
  };
}

function defaultContacts(): FakeContact[] {
  return [
    { displayName: "Jane Doe", phoneNumbers: [{ address: "+15551230001" }] },
    { displayName: "Sam Park", phoneNumbers: [{ address: "+15551230002" }] },
    { displayName: "Alex Kim", phoneNumbers: [{ address: "+15551230003" }] },
  ];
}
