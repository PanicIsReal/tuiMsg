import { BbClient, BbError } from "./bb/rest.ts";
import { connectBbSocket, type SocketHandlers } from "./bb/socket.ts";
import { openLocalFile, saveAttachment } from "./attachments.ts";
import { writeClipboard } from "./clipboard.ts";
import { parseHandleAddress, parseMessageGuid, type ChatGuid, type MessageGuid } from "./domain/ids.ts";
import { emptyState, privateApiAvailable, type AppEvent, type AppState, type Attachment, type Intent, type SavedSession, type Session } from "./domain/model.ts";
import { reduce } from "./domain/reduce.ts";
import { createJournal, type Journal } from "./journal.ts";

type SocketLike = { close: () => unknown };
type Timer = ReturnType<typeof setTimeout>;
type ImageLoad = {
  attachment: Attachment;
  promise: Promise<Uint8Array>;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
};

const MAX_ACTIVE_IMAGE_LOADS = 2;

export type SessionOptions = {
  url: string;
  password: string;
  client?: BbClient;
  journal?: Journal;
  clipboard?: (text: string) => void | Promise<void>;
  saveAttachment?: typeof saveAttachment;
  openFile?: (path: string) => Promise<void>;
  attachmentDirectory?: string;
  ssh?: boolean;
  quit?: () => void | Promise<void>;
  connectSocket?: (args: { url: string; password: string; handlers: SocketHandlers }) => SocketLike;
  now?: () => number;
};

export function createSession(options: SessionOptions): Session {
  const client = options.client ?? new BbClient({ url: options.url, password: options.password });
  const journal = options.journal ?? createJournal({ url: options.url, password: options.password });
  const clipboard = options.clipboard ?? writeClipboard;
  const saveFile = options.saveAttachment ?? saveAttachment;
  const openFile = options.openFile ?? openLocalFile;
  const socketFactory = options.connectSocket ?? connectBbSocket;
  const now = options.now ?? Date.now;
  let state = emptyState();
  let socket: SocketLike | undefined;
  let closed = false;
  let onlineOnce = false;
  let requestSequence = 0;
  let startPromise: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const historyLoads = new Map<ChatGuid, Promise<void>>();
  const effects = new Set<Promise<unknown>>();
  const typingStarts = new Map<ChatGuid, Timer>();
  const typingStops = new Map<ChatGuid, Timer>();
  const incomingTyping = new Map<ChatGuid, Timer>();
  const readRequests = new Map<ChatGuid, number>();
  const imageCache = new Map<string, Uint8Array>();
  const imageLoads = new Map<string, Promise<Uint8Array>>();
  const activeImageLoads = new Set<string>();
  let queuedImageLoad: ImageLoad | undefined;
  let imageCacheBytes = 0;
  let contactsLoad: Promise<void> | undefined;
  let serverWatermark = 0;
  let disconnectedAt: number | undefined;

  function snapshotForJournal(): SavedSession {
    return {
      drafts: [...state.drafts],
      outbox: [...state.outbox.values()],
      readAt: [...state.readAt],
    };
  }

  function report(error: unknown): void {
    if (closed) return;
    dispatch({ type: "notice", notice: { kind: "error", text: errorText(error) } }, false);
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    effects.add(promise);
    void promise.finally(() => effects.delete(promise)).catch(() => undefined);
    return promise;
  }

  function persist(): void {
    track(journal.save(snapshotForJournal())).catch(report);
  }

  function dispatch(event: AppEvent, save = true): void {
    if (closed) return;
    const previous = state;
    state = reduce(state, event, now());
    if (state !== previous) {
      for (const listener of listeners) listener();
      if (save && durableChange(event)) persist();
    }
    if (event.type === "connection" && event.connection === "online") {
      if (onlineOnce && previous.connection === "offline") track(reconcile()).catch(report);
      onlineOnce = true;
    }
    if (event.type === "connection" && event.connection === "offline") disconnectedAt = now();
    if (event.type === "message-upserted") {
      serverWatermark = Math.max(serverWatermark, event.message.sentAt);
      handleLiveMessage(event.message);
    }
    if (event.type === "typing") expireIncomingTyping(event.chatGuid, event.display);
  }

  function handleLiveMessage(message: Extract<AppEvent, { type: "message-upserted" }>['message']): void {
    if (message.kind === "text" && message.isFromMe && message.tempGuid && state.outbox.has(message.tempGuid)) {
      dispatch({ type: "send-acked", tempGuid: message.tempGuid, guid: message.guid });
    }
    if (!state.chats.has(message.chatGuid) || state.chats.get(message.chatGuid)?.provisional) {
      track(discoverChat(message.chatGuid)).catch(report);
    }
    if (message.kind === "text" && !message.isFromMe &&
        (state.input.kind === "transcript" || state.input.kind === "composer") && message.chatGuid === state.input.chatGuid) {
      markRead(message.chatGuid);
    }
  }

  async function discoverChat(chatGuid: ChatGuid): Promise<void> {
    const page = await client.listChats({ guid: chatGuid, limit: 1 });
    if (page.chats.length === 0) return;
    dispatch({ type: "chats-loaded", chats: page.chats });
    await loadContacts();
  }

  function loadContacts(): Promise<void> {
    if (contactsLoad) return contactsLoad;
    contactsLoad = client.queryContacts([])
      .then((contacts) => dispatch({ type: "contacts-loaded", contacts }))
      .catch(() => report(new Error("Contacts unavailable. Press R in the conversation list to retry.")))
      .finally(() => { contactsLoad = undefined; });
    return contactsLoad;
  }

  async function loadAllChats(): Promise<ChatGuid[]> {
    const guids: ChatGuid[] = [];
    let offset: number | null = 0;
    while (offset !== null && !closed) {
      const page = await client.listChats({ offset, limit: 200 });
      dispatch({ type: "chats-loaded", chats: page.chats });
      guids.push(...page.chats.map((chat) => chat.guid));
      offset = page.nextOffset;
    }
    dispatch({ type: "chats-status", status: "ready" });
    return [...new Set(guids)];
  }

  function loadHistory(chatGuid: ChatGuid, mode: "latest" | "older"): Promise<void> {
    const current = historyLoads.get(chatGuid);
    if (current) return current;
    const request = ++requestSequence;
    const history = state.history.get(chatGuid);
    if (mode === "older" && history?.kind === "ready" && history.next === null) return Promise.resolve();
    const cursor = mode === "older" && history && "next" in history ? history.next ?? undefined : undefined;
    dispatch({ type: "history-loading", chatGuid, request, mode });
    const operation = client.listMessages(chatGuid, { ...(cursor ? { cursor } : {}) })
      .then((page) => {
        reconcileOutbox(page.messages);
        dispatch({ type: "history-loaded", chatGuid, request, page });
      })
      .catch((error) => dispatch({ type: "history-failed", chatGuid, request, message: errorText(error) }))
      .finally(() => historyLoads.delete(chatGuid));
    historyLoads.set(chatGuid, operation);
    track(operation).catch(() => undefined);
    return operation;
  }

  async function hydrate(): Promise<void> {
    dispatch({ type: "connection", connection: "connecting" });
    const [online, capabilities] = await Promise.all([client.ping(), client.serverInfo()]);
    dispatch({ type: "connection", connection: online ? "online" : "offline" });
    dispatch({ type: "capabilities", capabilities });
    await loadAllChats();
    track(loadContacts()).catch(() => undefined);
  }

  async function reconcile(): Promise<void> {
    if (closed) return;
    const before = now();
    const after = Math.max(0, Math.min(serverWatermark || before, disconnectedAt ?? before) - 1_000);
    let offset: number | null = 0;
    while (offset !== null && !closed) {
      const page = await client.messagesSince({ after, before, offset, limit: 200 });
      for (const message of page.messages) dispatch({ type: "message-upserted", message });
      offset = page.nextOffset;
    }
    disconnectedAt = undefined;
    const loaded = [...state.history.entries()].filter(([, value]) => value.kind !== "unloaded").map(([guid]) => guid);
    await loadAllChats();
    await Promise.all(loaded.map((guid) => loadHistory(guid, "latest")));
  }

  function markRead(chatGuid: ChatGuid): void {
    dispatch({ type: "mark-read", chatGuid });
    if (!privateApiAvailable(state.capabilities)) return;
    const request = (readRequests.get(chatGuid) ?? 0) + 1;
    readRequests.set(chatGuid, request);
    dispatch({ type: "read-requested", chatGuid });
    track(client.markRead(chatGuid)).then(() => {
      if (readRequests.get(chatGuid) !== request) return;
      dispatch({ type: "read-succeeded", chatGuid });
    }).catch((error) => {
      if (readRequests.get(chatGuid) !== request) return;
      dispatch({ type: "read-failed", chatGuid, message: errorText(error) });
    });
  }

  function updateTyping(chatGuid: ChatGuid, text: string): void {
    clearTimer(typingStarts, chatGuid);
    clearTimer(typingStops, chatGuid);
    if (!privateApiAvailable(state.capabilities)) return;
    if (!text.trim()) {
      track(client.stopTyping(chatGuid)).catch(() => undefined);
      return;
    }
    typingStarts.set(chatGuid, setTimeout(() => {
      typingStarts.delete(chatGuid);
      track(client.startTyping(chatGuid)).catch(() => undefined);
    }, 250));
    typingStops.set(chatGuid, setTimeout(() => {
      typingStops.delete(chatGuid);
      track(client.stopTyping(chatGuid)).catch(() => undefined);
    }, 5_000));
  }

  function send(chatGuid: ChatGuid, retry?: MessageGuid): void {
    const existing = retry ? state.outbox.get(retry) : undefined;
    const draft = state.drafts.get(chatGuid);
    const text = existing?.text ?? draft?.text ?? "";
    if (!text.trim()) return;
    const tempGuid = retry ?? parseMessageGuid(crypto.randomUUID());
    const replyTo = existing?.replyTo ?? draft?.replyTo ?? null;
    if (!existing) dispatch({ type: "send-requested", chatGuid, text, tempGuid, ...(replyTo ? { replyTo } : {}) });
    const promise = journal.flush().then(() => client.sendText({ chatGuid, message: text, tempGuid, ...(replyTo ? { replyTo } : {}) }))
      .then((message) => {
        if (state.outbox.has(tempGuid)) dispatch({ type: "send-acked", tempGuid, guid: message.guid });
        dispatch({ type: "message-upserted", message });
      })
      .catch((error) => {
        if (!state.outbox.has(tempGuid)) return;
        dispatch({ type: "send-failed", tempGuid, error: errorText(error), uncertain: error instanceof BbError && error.ambiguous });
      });
    track(promise).catch(() => undefined);
  }

  function reconcileOutbox(messages: Extract<AppEvent, { type: "messages-loaded" }>['messages']): void {
    for (const message of messages) {
      if (message.kind === "text" && message.isFromMe && message.tempGuid && state.outbox.has(message.tempGuid)) {
        dispatch({ type: "send-acked", tempGuid: message.tempGuid, guid: message.guid });
      }
    }
  }

  function createChat(intent: Extract<Intent, { type: "create-chat" }>): void {
    const input = state.input;
    if (input.kind !== "new-chat" || input.busy) return;
    const addresses = intent.addresses.split(/[;,\n]/).map((value) => value.trim()).filter(Boolean);
    if (!addresses.length || !intent.text.trim()) return;
    dispatch({ type: "input", input: { ...input, busy: true, error: null } });
    const tempGuid = parseMessageGuid(crypto.randomUUID());
    const promise = client.createChat({ addresses, message: intent.text.trim(), service: intent.service, tempGuid })
      .then(({ chat, messages }) => {
        dispatch({ type: "chats-loaded", chats: [chat] });
        dispatch({ type: "messages-loaded", chatGuid: chat.guid, messages });
        act({ type: "open-chat", chatGuid: chat.guid });
        void loadContacts();
      })
      .catch((error) => {
        const current = state.input;
        if (current.kind === "new-chat") {
          const uncertain = error instanceof BbError && error.ambiguous;
          const message = uncertain ? `${errorText(error)} Delivery is uncertain. Close this form before trying again.` : errorText(error);
          dispatch({ type: "input", input: { ...current, busy: uncertain, error: message } });
        }
      });
    track(promise).catch(() => undefined);
  }

  function act(intent: Intent): void {
    if (closed) return;
    dispatch(intent);
    switch (intent.type) {
      case "open-chat": void loadHistory(intent.chatGuid, "latest"); markRead(intent.chatGuid); break;
      case "draft-set": updateTyping(intent.chatGuid, intent.text); break;
      case "send": clearTyping(intent.chatGuid); send(intent.chatGuid); break;
      case "retry-send": if (intent.confirmed || state.outbox.get(intent.tempGuid)?.phase !== "uncertain") { const outgoing = state.outbox.get(intent.tempGuid); if (outgoing) send(outgoing.chatGuid, intent.tempGuid); } break;
      case "load-history": void loadHistory(intent.chatGuid, intent.mode); break;
      case "refresh": track(hydrate()).catch((error) => { dispatch({ type: "chats-status", status: "error" }); report(error); }); break;
      case "retry-read": markRead(intent.chatGuid); break;
      case "react": track(client.sendReaction(intent).then((message) => { if (message) dispatch({ type: "message-upserted", message }); })).catch(report); break;
      case "create-chat": createChat(intent); break;
      case "attachment": track(handleAttachment(intent)).catch(report); break;
      case "copy": track(Promise.resolve(clipboard(intent.text))).then(() => dispatch({ type: "notice", notice: { kind: "info", text: "Copied." } })).catch(report); break;
      case "quit": track(Promise.resolve(options.quit?.())).catch(report); break;
    }
  }

  async function loadAttachment(attachment: Attachment): Promise<Uint8Array> {
    if (closed) throw new Error("Session is closed");
    const cached = imageCache.get(attachment.guid);
    if (cached) {
      imageCache.delete(attachment.guid);
      imageCache.set(attachment.guid, cached);
      return cached;
    }
    const pending = imageLoads.get(attachment.guid);
    if (pending) return pending;
    let resolve!: ImageLoad["resolve"];
    let reject!: ImageLoad["reject"];
    const promise = new Promise<Uint8Array>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const load = { attachment, promise, resolve, reject };
    imageLoads.set(attachment.guid, promise);
    if (activeImageLoads.size < MAX_ACTIVE_IMAGE_LOADS) startImageLoad(load);
    else {
      const superseded = queuedImageLoad;
      queuedImageLoad = load;
      if (superseded) {
        imageLoads.delete(superseded.attachment.guid);
        superseded.reject(new Error("Image preview superseded by a newer request."));
      }
    }
    return promise;
  }

  function startImageLoad(load: ImageLoad): void {
    const guid = load.attachment.guid;
    activeImageLoads.add(guid);
    client.previewAttachment(load.attachment).then((bytes) => {
      if (closed) {
        load.reject(new Error("Session is closed"));
        return;
      }
      if (bytes.byteLength > 16 * 1024 * 1024) {
        load.reject(new Error("Image is too large to preview. Use o to open the original."));
        return;
      }
      while (imageCache.size >= 12 || imageCacheBytes + bytes.byteLength > 24 * 1024 * 1024) {
        const oldest = imageCache.entries().next().value;
        if (!oldest) break;
        imageCache.delete(oldest[0]);
        imageCacheBytes -= oldest[1].byteLength;
      }
      imageCache.set(guid, bytes);
      imageCacheBytes += bytes.byteLength;
      load.resolve(bytes);
    }, (error: unknown) => load.reject(error instanceof Error ? error : new Error(String(error))))
      .finally(() => {
        activeImageLoads.delete(guid);
        if (imageLoads.get(guid) === load.promise) imageLoads.delete(guid);
        const next = queuedImageLoad;
        if (!closed && next) {
          queuedImageLoad = undefined;
          startImageLoad(next);
        }
      });
  }

  async function handleAttachment(intent: Extract<Intent, { type: "attachment" }>): Promise<void> {
    const bytes = await client.downloadAttachment(intent.attachment);
    const path = await saveFile({ attachment: intent.attachment, bytes, ...(options.attachmentDirectory ? { directory: options.attachmentDirectory } : {}) });
    if (intent.action === "open" && !options.ssh) {
      await openFile(path);
      dispatch({ type: "notice", notice: { kind: "info", text: `Opened ${path}` } });
      return;
    }
    const prefix = intent.action === "open" && options.ssh ? "Saved on the server" : "Saved";
    dispatch({ type: "notice", notice: { kind: "info", text: `${prefix} at ${path}` } });
  }

  async function start(): Promise<void> {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        const saved = await journal.load();
        if (saved) dispatch({ type: "restore", saved });
      } catch (error) {
        report(error);
      }
      if (closed) return;
      socket = socketFactory({ url: options.url, password: options.password, handlers: { dispatch, diagnostic: report } });
      try {
        await hydrate();
      } catch (error) {
        dispatch({ type: "connection", connection: error instanceof BbError && error.kind === "auth" ? "auth-failed" : "offline" });
        dispatch({ type: "chats-status", status: "error" });
        report(error);
      }
    })();
    return startPromise;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const timer of typingStarts.values()) clearTimeout(timer);
    for (const timer of typingStops.values()) clearTimeout(timer);
    for (const timer of incomingTyping.values()) clearTimeout(timer);
    typingStarts.clear();
    typingStops.clear();
    incomingTyping.clear();
    historyLoads.clear();
    imageCache.clear();
    imageCacheBytes = 0;
    if (queuedImageLoad) {
      queuedImageLoad.reject(new Error("Session is closed"));
      queuedImageLoad = undefined;
    }
    activeImageLoads.clear();
    imageLoads.clear();
    readRequests.clear();
    socket?.close();
    await client.close();
    listeners.clear();
    effects.clear();
    await journal.flush();
  }

  function clearTyping(chatGuid: ChatGuid): void {
    clearTimer(typingStarts, chatGuid);
    clearTimer(typingStops, chatGuid);
    if (privateApiAvailable(state.capabilities)) track(client.stopTyping(chatGuid)).catch(() => undefined);
  }

  function expireIncomingTyping(chatGuid: ChatGuid, display: boolean): void {
    clearTimer(incomingTyping, chatGuid);
    if (!display) return;
    incomingTyping.set(chatGuid, setTimeout(() => {
      incomingTyping.delete(chatGuid);
      dispatch({ type: "typing", chatGuid, display: false }, false);
    }, 8_000));
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    act,
    loadAttachment,
    start,
    close,
  };
}

function clearTimer(map: Map<ChatGuid, Timer>, chatGuid: ChatGuid): void {
  const timer = map.get(chatGuid);
  if (timer) clearTimeout(timer);
  map.delete(chatGuid);
}

function durableChange(event: AppEvent): boolean {
  return ["draft-set", "reply", "send-requested", "send-acked", "send-failed", "retry-send", "mark-read", "restore"].includes(event.type);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
