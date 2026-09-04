import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as IoServer } from "socket.io";
import type { AddressInfo } from "node:net";

export type FakeMessage = {
  guid: string
  chatGuid: string
  text: string
  isFromMe: boolean
  dateCreated: number
  dateDelivered?: number
  dateRead?: number
  handle?: { address: string; service: string }
  tempGuid?: string
  itemType?: number
  groupActionType?: number
  associatedMessageType?: number
  associatedMessageGuid?: string
  attachments?: unknown[]
  chats?: { guid: string }[]
};

export type FakeChat = {
  guid: string
  style: number
  displayName: string
  unreadCount: number
  participants: { address: string; service: string }[]
  lastMessage?: FakeMessage
};

export type FakeContact = {
  displayName: string
  phoneNumbers?: { address: string }[]
  emails?: { address: string }[]
};

export type FakeOptions = {
  helperConnected?: boolean
  privateApi?: boolean
  chats?: FakeChat[]
  messages?: Record<string, FakeMessage[]>
  contacts?: FakeContact[]
};

function json(res: ServerResponse, status: number, data: unknown, message = "Success"): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status, message, data }));
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
  password = "test-password";
  private server = createServer((req, res) => {
    void this.route(req, res);
  });
  private io = new IoServer(this.server, { cors: { origin: "*" } });
  private startedAt = 0;

  constructor(options: FakeOptions = {}) {
    this.helperConnected = options.helperConnected ?? true;
    this.privateApi = options.privateApi ?? true;
    this.chats = options.chats ?? defaultChats();
    this.messages = new Map(Object.entries(options.messages ?? defaultMessages()));
    this.contacts = options.contacts ?? defaultContacts();
    this.io.use((socket, next) => {
      const pwd = String(socket.handshake.query.password ?? socket.handshake.query.guid ?? "");
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
    this.startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", resolve);
    });
  }

  async close(): Promise<void> {
    try {
      this.io.close();
    } catch {
      /* socket.io throws if the http server never started */
    }
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  emit(event: string, data: unknown): void {
    this.io.emit(event, data);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = this.startedAt;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (passwordOf(req) !== this.password) {
      json(res, 401, null, "Unauthorized");
      return;
    }
    const path = url.pathname;
    const method = req.method ?? "GET";

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
      json(res, 200, this.chats);
      return;
    }
    if (method === "GET" && path.startsWith("/api/v1/chat/") && path.endsWith("/message")) {
      const encoded = path.slice("/api/v1/chat/".length, -"/message".length);
      const guid = decodeURIComponent(encoded);
      json(res, 200, this.messages.get(guid) ?? []);
      return;
    }
    if (method === "POST" && path === "/api/v1/message/text") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const chatGuid = String(body.chatGuid ?? "");
      const message: FakeMessage = {
        guid: crypto.randomUUID(),
        chatGuid,
        text: String(body.message ?? ""),
        isFromMe: true,
        dateCreated: Date.now(),
        dateDelivered: Date.now(),
        handle: { address: "me", service: "iMessage" },
        tempGuid: String(body.tempGuid ?? ""),
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
      json(res, 200, true);
      return;
    }
    if (method === "POST" && path.endsWith("/typing")) {
      json(res, 200, true);
      return;
    }
    void started;
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
