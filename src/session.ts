import { attachmentPath, openLocalFile, readAttachment, saveAttachment } from "./attachments.ts";
import { writeClipboard } from "./clipboard.ts";
import { contactLookupKey, parseMessageGuid, type ChatGuid, type MessageGuid } from "./domain/ids.ts";
import { bridgeAvailable, chatActivity, emptyState, type AppEvent, type AppState, type Attachment, type Contact, type Intent, type Message, type SavedSession, type Session, type TextMessage } from "./domain/model.ts";
import { reduce } from "./domain/reduce.ts";
import { lastOwnReceipt } from "./domain/view.ts";
import { BackendError, ImsgClient } from "./imsg/client.ts";
import { parseMessageRecord, type ParsedRecord } from "./imsg/parse.ts";
import { ImsgMissingError, RpcConnection, type RpcConnector } from "./imsg/rpc.ts";
import { createJournal, type Journal } from "./journal.ts";

type Timer = ReturnType<typeof setTimeout>;
type ImageLoad = {
  attachment: Attachment;
  promise: Promise<Uint8Array>;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
};
type LocalSend = { chatGuid: ChatGuid; text: string; createdAt: number };

const MAX_ACTIVE_IMAGE_LOADS = 2;
const CHAT_LIMIT = 500;
const HISTORY_PAGE = 50;
const PREVIEW_CONCURRENCY = 2;
const RESTART_DELAYS = [1_000, 2_000, 5_000, 15_000];

export type SessionOptions = {
  // Starts one `imsg rpc` child; called again to restart it.
  connect: () => RpcConnector;
  journal?: Journal;
  clipboard?: (text: string) => void | Promise<void>;
  saveAttachment?: typeof saveAttachment;
  openFile?: (path: string) => Promise<void>;
  readAttachment?: (attachment: Attachment) => Promise<Uint8Array>;
  attachmentDirectory?: string;
  ssh?: boolean;
  quit?: () => void | Promise<void>;
  now?: () => number;
  restartDelays?: number[];
};

export function createSession(options: SessionOptions): Session {
  const journal = options.journal ?? createJournal();
  const clipboard = options.clipboard ?? writeClipboard;
  const saveFile = options.saveAttachment ?? saveAttachment;
  const openFile = options.openFile ?? openLocalFile;
  const loadBytes = options.readAttachment ?? readAttachment;
  const restartDelays = options.restartDelays ?? RESTART_DELAYS;
  const now = options.now ?? Date.now;
  let state = emptyState();
  let client: ImsgClient | undefined;
  let connecting: Promise<void> | undefined;
  let subscription: number | undefined;
  let lastRowId: number | undefined;
  let restartTimer: Timer | undefined;
  let restartAttempt = 0;
  let blocked = false;
  let closed = false;
  let requestSequence = 0;
  let startPromise: Promise<void> | undefined;
  let chatsReload: Timer | undefined;
  const listeners = new Set<() => void>();
  const historyLoads = new Map<ChatGuid, Promise<void>>();
  const effects = new Set<Promise<unknown>>();
  const typingStarts = new Map<ChatGuid, Timer>();
  const typingStops = new Map<ChatGuid, Timer>();
  const incomingTyping = new Map<ChatGuid, Timer>();
  const receiptChecks = new Set<Timer>();
  const readRequests = new Map<ChatGuid, number>();
  const previewed = new Set<ChatGuid>();
  const ackedGuids = new Set<MessageGuid>();
  const localSends = new Map<MessageGuid, LocalSend>();
  const imageCache = new Map<string, Uint8Array>();
  const imageLoads = new Map<string, Promise<Uint8Array>>();
  const activeImageLoads = new Map<string, ImageLoad>();
  const queuedImageLoads: ImageLoad[] = [];
  let imageCacheBytes = 0;

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
    if (event.type === "message-upserted") handleLiveMessage(event.message);
    if (event.type === "typing") expireIncomingTyping(event.chatGuid, event.display);
  }

  function bridge(): boolean {
    return bridgeAvailable(state.capabilities);
  }

  // imsg streams names alongside rows; only dispatch ones the state has not seen, since
  // applying contacts touches every chat and loaded message.
  function learn(contacts: Contact[]): void {
    const fresh = contacts.filter((contact) => [...contact.phones, ...contact.emails].some((address) => state.contacts.get(contactLookupKey(address))?.displayName !== contact.displayName));
    if (fresh.length) dispatch({ type: "contacts-loaded", contacts: fresh });
  }

  function handleLiveMessage(message: Message): void {
    if (message.kind === "text" && message.isFromMe) matchLocalSend(message);
    const chat = state.chats.get(message.chatGuid);
    if (!chat || chat.provisional || chat.rowId === undefined) scheduleChatsReload();
    if (message.kind === "text" && !message.isFromMe &&
        (state.input.kind === "transcript" || state.input.kind === "composer") && message.chatGuid === state.input.chatGuid) {
      markRead(message.chatGuid);
    }
  }

  // imsg cannot tag a send with our temporary GUID, so an outgoing row that streams in
  // before (or instead of) the send result is matched to its pending bubble by chat and text.
  function matchLocalSend(message: TextMessage): void {
    if (ackedGuids.has(message.guid) || message.guid.startsWith("local-")) return;
    const text = message.body.trim();
    // Only rows written after the send started can be its result.
    const near = (createdAt: number) => message.sentAt >= createdAt - 5_000 && message.sentAt - createdAt < 10 * 60_000;
    for (const [tempGuid, outgoing] of state.outbox) {
      if (outgoing.chatGuid === message.chatGuid && outgoing.text.trim() === text && near(outgoing.createdAt)) {
        ackedGuids.add(message.guid);
        dispatch({ type: "send-acked", tempGuid, guid: message.guid });
        return;
      }
    }
    for (const [tempGuid, sent] of localSends) {
      if (sent.chatGuid === message.chatGuid && sent.text.trim() === text && near(sent.createdAt)) {
        localSends.delete(tempGuid);
        ackedGuids.add(message.guid);
        dispatch({ type: "send-acked", tempGuid, guid: message.guid });
        return;
      }
    }
  }

  function applyRecord(record: ParsedRecord): void {
    if (record.rowId !== undefined) lastRowId = Math.max(lastRowId ?? 0, record.rowId);
    learn(record.contacts);
    for (const message of record.messages) dispatch({ type: "message-upserted", message });
  }

  function notification(method: string, params: unknown): void {
    const payload = typeof params === "object" && params !== null ? params as Record<string, unknown> : {};
    if (method === "message" && payload.subscription === subscription) {
      try { applyRecord(parseMessageRecord(payload.message)); } catch { /* skip malformed rows */ }
    } else if (method === "watch.overflow" && payload.subscription === subscription) {
      // The cursor is at or before the first dropped row, so resuming from it cannot skip one.
      if (typeof payload.resume_after_rowid === "number") lastRowId = payload.resume_after_rowid;
      subscription = undefined;
      const active = client;
      if (active) track(active.subscribe(lastRowId).then((id) => { if (client === active) subscription = id; })).catch(stopped);
    } else if (method === "bridge.event") {
      const event = typeof payload.event === "object" && payload.event !== null ? payload.event as Record<string, unknown> : {};
      const data = typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : {};
      const chatGuid = typeof data.chatGuid === "string" ? data.chatGuid as ChatGuid : undefined;
      if (chatGuid && state.chats.has(chatGuid) && (event.event === "started-typing" || event.event === "stopped-typing")) {
        dispatch({ type: "typing", chatGuid, display: event.event === "started-typing" }, false);
      }
    }
  }

  function connect(): Promise<void> {
    if (connecting) return connecting;
    connecting = (async () => {
      clearRestart();
      const previous = client;
      client = undefined;
      subscription = undefined;
      await previous?.close().catch(() => undefined);
      if (closed) return;
      dispatch({ type: "connection", connection: "connecting" });
      const rpc = new RpcConnection(options.connect());
      const active = new ImsgClient(rpc);
      client = active;
      rpc.onNotification((method, params) => { if (client === active) notification(method, params); });
      rpc.onExit((error) => { if (client === active) stopped(error); });
      try {
        const status = await active.status();
        if (client !== active) return;
        dispatch({ type: "capabilities", capabilities: { bridge: status.bridgeReady } });
        if (!status.databaseReady) {
          dispatch({ type: "connection", connection: "no-access" });
          dispatch({ type: "chats-status", status: "error" });
          report(new Error(accessHelp(status.databaseError)));
          return;
        }
        // Subscribe before listing so nothing that arrives in between is missed.
        subscription = await active.subscribe(lastRowId);
        if (client !== active) return;
        blocked = false;
        restartAttempt = 0;
        dispatch({ type: "connection", connection: "online" });
        await loadChats(active);
        void loadPreviews(active);
        const loaded = [...state.history.entries()].filter(([, value]) => value.kind !== "unloaded").map(([guid]) => guid);
        for (const guid of loaded) void loadHistory(guid, "latest");
        if (status.bridgeReady) track(active.subscribeBridgeEvents()).catch(() => undefined);
      } catch (error) {
        if (client !== active) return;
        failConnection(error);
      }
    })().finally(() => { connecting = undefined; });
    return connecting;
  }

  function failConnection(error: unknown): void {
    const missing = error instanceof BackendError && (error.kind === "missing" || error.kind === "access");
    dispatch({ type: "connection", connection: missing ? "no-access" : "offline" });
    if (state.chatsStatus !== "ready") dispatch({ type: "chats-status", status: "error" });
    report(error instanceof BackendError && error.kind === "access" ? new Error(accessHelp(error.message)) : error);
    if (!missing) scheduleRestart();
  }

  // The child exited underneath us. Pending requests were already rejected; restart it and
  // resume the watch from the last row seen so nothing is lost in between.
  function stopped(error: unknown): void {
    if (closed) return;
    const dead = client;
    client = undefined;
    subscription = undefined;
    void dead?.close().catch(() => undefined);
    failConnection(error instanceof ImsgMissingError ? new BackendError("missing", error.message) : error);
  }

  function scheduleRestart(): void {
    if (closed || restartTimer) return;
    const delay = restartDelays[Math.min(restartAttempt, restartDelays.length - 1)] ?? 15_000;
    restartAttempt += 1;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      track(connect()).catch(report);
    }, delay);
  }

  function clearRestart(): void {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;
  }

  function accessHelp(detail: string | null): string {
    const fix = options.ssh
      ? "On the Mac, turn on System Settings > General > Sharing > Remote Login > Allow full disk access for remote users, then reconnect over SSH."
      : "Give your terminal Full Disk Access in System Settings > Privacy & Security, then relaunch it.";
    return `Cannot read the Messages database${detail ? ` (${detail})` : ""}. ${fix}`;
  }

  async function loadChats(active = client): Promise<void> {
    if (!active) throw new BackendError("stopped", "imsg is not running");
    const { chats, contacts } = await active.chats(CHAT_LIMIT);
    if (client !== active) return;
    dispatch({ type: "chats-loaded", chats });
    learn(contacts);
    dispatch({ type: "chats-status", status: "ready" });
  }

  // chats.list has no message text, so fetch each chat's newest message for its preview.
  async function loadPreviews(active: ImsgClient): Promise<void> {
    const queue = [...state.chats.values()]
      .filter((chat) => chat.rowId !== undefined && !previewed.has(chat.guid))
      .sort((a, b) => chatActivity(b) - chatActivity(a));
    const worker = async () => {
      for (let chat = queue.shift(); chat && client === active && !closed; chat = queue.shift()) {
        // Marked when started, so a restart leaves unfetched chats for the next pass.
        if (previewed.has(chat.guid)) continue;
        previewed.add(chat.guid);
        try {
          const page = await active.history(chat.rowId!, { limit: 1 });
          const record = page.records[0];
          const message = record?.messages[0];
          if (!record || !message || client !== active) continue;
          learn(record.contacts);
          dispatch({ type: "chat-preview", chatGuid: chat.guid, message });
        } catch {
          previewed.delete(chat.guid);
        }
      }
    };
    await Promise.all(Array.from({ length: PREVIEW_CONCURRENCY }, worker));
  }

  function scheduleChatsReload(): void {
    if (chatsReload || closed) return;
    chatsReload = setTimeout(() => {
      chatsReload = undefined;
      const active = client;
      if (!active) return;
      track(loadChats(active).then(() => loadPreviews(active))).catch(() => undefined);
    }, 300);
  }

  function loadHistory(chatGuid: ChatGuid, mode: "latest" | "older"): Promise<void> {
    const current = historyLoads.get(chatGuid);
    if (current) return current;
    const history = state.history.get(chatGuid);
    if (mode === "older" && history?.kind === "ready" && history.next === null) return Promise.resolve();
    const before = mode === "older" && history && "next" in history ? history.next?.before : undefined;
    const request = ++requestSequence;
    dispatch({ type: "history-loading", chatGuid, request, mode });
    const chat = state.chats.get(chatGuid);
    const active = client;
    const operation = (async () => {
      if (!active) throw new BackendError("stopped", "imsg is not running. Press R to retry.");
      if (chat?.rowId === undefined) throw new BackendError("invalid", "This conversation is not in the Messages database yet.");
      return active.history(chat.rowId, { limit: HISTORY_PAGE, ...(before !== undefined ? { before } : {}) });
    })()
      .then((page) => {
        for (const record of page.records) learn(record.contacts);
        const messages = page.records.flatMap((record) => record.messages);
        const oldest = page.records.reduce<number | undefined>((min, record) => {
          const sentAt = record.messages[0]?.sentAt;
          return sentAt === undefined ? min : Math.min(min ?? sentAt, sentAt);
        }, undefined);
        dispatch({ type: "history-loaded", chatGuid, request, page: { messages, next: page.count >= HISTORY_PAGE && oldest !== undefined ? { before: oldest } : null } });
        for (const message of messages) if (message.kind === "text" && message.isFromMe) matchLocalSend(message);
        if (mode === "latest") checkReceipt(chatGuid);
      })
      .catch((error) => dispatch({ type: "history-failed", chatGuid, request, message: errorText(error) }))
      .finally(() => historyLoads.delete(chatGuid));
    historyLoads.set(chatGuid, operation);
    track(operation).catch(() => undefined);
    return operation;
  }

  // Shows Delivered/Read under the newest outgoing message, like Messages does.
  function checkReceipt(chatGuid: ChatGuid, delay = 0): void {
    const timer = setTimeout(() => {
      receiptChecks.delete(timer);
      const message = lastOwnReceipt(state.messages.get(chatGuid) ?? []);
      const active = client;
      if (!message || !active || message.guid.startsWith("local-") || message.status === "read") return;
      track(active.sendStatus(message.guid).then((receipt) => {
        const status = receipt.readAt ? "read" : receipt.state === "delivered" ? "delivered" : receipt.state === "failed" ? "failed" : undefined;
        if (!status || status === message.status) return;
        dispatch({ type: "message-upserted", message: { ...message, status, ...(receipt.deliveredAt ? { deliveredAt: receipt.deliveredAt } : {}), ...(receipt.readAt ? { readAt: receipt.readAt } : {}) } });
      })).catch(() => undefined);
    }, delay);
    receiptChecks.add(timer);
  }

  function markRead(chatGuid: ChatGuid): void {
    dispatch({ type: "mark-read", chatGuid });
    const active = client;
    // Read receipts need imsg's bridge; without it `read` may bring Messages to the front.
    if (!bridge() || !active) return;
    const request = (readRequests.get(chatGuid) ?? 0) + 1;
    readRequests.set(chatGuid, request);
    dispatch({ type: "read-requested", chatGuid });
    track(active.markRead(chatGuid)).then(() => {
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
    const active = client;
    if (!bridge() || !active) return;
    if (!text.trim()) {
      track(active.typing(chatGuid, false)).catch(() => undefined);
      return;
    }
    typingStarts.set(chatGuid, setTimeout(() => {
      typingStarts.delete(chatGuid);
      track(active.typing(chatGuid, true)).catch(() => undefined);
    }, 250));
    typingStops.set(chatGuid, setTimeout(() => {
      typingStops.delete(chatGuid);
      track(active.typing(chatGuid, false)).catch(() => undefined);
    }, 5_000));
  }

  function send(chatGuid: ChatGuid, retry?: MessageGuid): void {
    const existing = retry ? state.outbox.get(retry) : undefined;
    const draft = state.drafts.get(chatGuid);
    const text = existing?.text ?? draft?.text ?? "";
    if (!text.trim()) return;
    const tempGuid = retry ?? parseMessageGuid(`local-${crypto.randomUUID()}`);
    const replyTo = existing?.replyTo ?? draft?.replyTo ?? null;
    if (!existing) dispatch({ type: "send-requested", chatGuid, text, tempGuid, ...(replyTo ? { replyTo } : {}) });
    const active = client;
    const refusal = !active ? "imsg is not running. Press Shift+R in the conversation list to restart it."
      : blocked ? "imsg is holding an earlier send whose outcome is unknown. Check Messages, then press Shift+R in the conversation list to restart imsg."
      : replyTo && !bridge() ? "Replies need the imsg bridge. Send without replying, or start the bridge with imsg launch."
      : undefined;
    if (refusal !== undefined || !active) {
      const error = refusal ?? "imsg is not running.";
      dispatch({ type: "send-failed", tempGuid, error, uncertain: false });
      report(new Error(error));
      return;
    }
    const promise = journal.flush().then(() => active.sendText({ chatGuid, text, ...(replyTo ? { replyTo } : {}) }))
      .then((result) => {
        if (result.guid) {
          ackedGuids.add(result.guid);
          if (state.outbox.has(tempGuid)) dispatch({ type: "send-acked", tempGuid, guid: result.guid });
          checkReceipt(chatGuid, 3_000);
          checkReceipt(chatGuid, 15_000);
        } else {
          // Messages accepted it but imsg did not observe the row yet; match it when it streams in.
          localSends.set(tempGuid, { chatGuid, text, createdAt: now() });
          if (state.outbox.has(tempGuid)) dispatch({ type: "send-acked", tempGuid, guid: tempGuid });
        }
      })
      .catch((error) => {
        if (error instanceof BackendError && error.kind === "blocked") blocked = true;
        if (!state.outbox.has(tempGuid)) return;
        dispatch({ type: "send-failed", tempGuid, error: errorText(error), uncertain: error instanceof BackendError && error.ambiguous });
        report(error);
      });
    track(promise).catch(() => undefined);
  }

  function createChat(intent: Extract<Intent, { type: "create-chat" }>): void {
    const input = state.input;
    if (input.kind !== "new-chat" || input.busy) return;
    const addresses = intent.addresses.split(/[;,\n]/).map((value) => value.trim()).filter(Boolean);
    const text = intent.text.trim();
    if (!addresses.length || !text) return;
    const active = client;
    const refusal = !active ? "imsg is not running." : addresses.length > 1 && !bridge() ? "Group conversations need the imsg bridge. Start one in Messages, or run imsg launch." : undefined;
    if (refusal || !active) {
      dispatch({ type: "input", input: { ...input, error: refusal ?? "imsg is not running." } });
      return;
    }
    dispatch({ type: "input", input: { ...input, busy: true, error: null } });
    const operation = addresses.length === 1
      ? active.sendDirect({ to: addresses[0]!, text, service: intent.service })
      : active.createChat({ addresses, text });
    const promise = operation
      .then(async (result) => {
        if (result.guid) ackedGuids.add(result.guid);
        await loadChats(active);
        const chatGuid = result.chatGuid && state.chats.has(result.chatGuid) ? result.chatGuid : findDirectChat(addresses);
        if (chatGuid) act({ type: "open-chat", chatGuid });
        else {
          dispatch({ type: "input", input: { kind: "list" } });
          dispatch({ type: "notice", notice: { kind: "info", text: "Sent. The conversation appears once Messages records it." } }, false);
        }
      })
      .catch((error) => {
        const current = state.input;
        if (current.kind !== "new-chat") return;
        const uncertain = error instanceof BackendError && error.ambiguous;
        const message = uncertain ? `${errorText(error)} Delivery is uncertain. Close this form before trying again.` : errorText(error);
        dispatch({ type: "input", input: { ...current, busy: uncertain, error: message } });
      });
    track(promise).catch(() => undefined);
  }

  function findDirectChat(addresses: string[]): ChatGuid | undefined {
    if (addresses.length !== 1) return undefined;
    const key = contactLookupKey(addresses[0]!);
    for (const chat of state.chats.values()) {
      if (chat.kind === "dm" && chat.participants.some((participant) => contactLookupKey(participant.address) === key)) return chat.guid;
    }
    return undefined;
  }

  function react(intent: Extract<Intent, { type: "react" }>): void {
    const active = client;
    if (!bridge() || !active) {
      report(new Error("Reactions need the imsg bridge (imsg launch), which requires SIP to be disabled."));
      return;
    }
    track(active.tapback(intent)).catch(report);
  }

  function refresh(): void {
    // A stopped, blocked, or unreadable backend needs a fresh child; otherwise re-list.
    const active = client;
    if (!active || blocked || state.connection !== "online") {
      track(connect()).catch(report);
      return;
    }
    track(loadChats(active).then(() => loadPreviews(active))).catch((error) => {
      dispatch({ type: "chats-status", status: "error" });
      report(error);
    });
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
      case "refresh": refresh(); break;
      case "retry-read": markRead(intent.chatGuid); break;
      case "react": react(intent); break;
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
    else queuedImageLoads.push(load);
    return promise;
  }

  function startImageLoad(load: ImageLoad): void {
    const guid = load.attachment.guid;
    activeImageLoads.set(guid, load);
    loadBytes(load.attachment).then((bytes) => {
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
        if (!closed) {
          const next = queuedImageLoads.shift();
          if (next) startImageLoad(next);
        }
      });
  }

  async function handleAttachment(intent: Extract<Intent, { type: "attachment" }>): Promise<void> {
    // The file is already on this Mac; opening locally needs no copy.
    if (intent.action === "open" && !options.ssh) {
      await openFile(attachmentPath(intent.attachment));
      dispatch({ type: "notice", notice: { kind: "info", text: `Opened ${intent.attachment.name}` } });
      return;
    }
    const path = await saveFile({ attachment: intent.attachment, ...(options.attachmentDirectory ? { directory: options.attachmentDirectory } : {}) });
    const prefix = intent.action === "open" ? "Saved on this Mac" : "Saved";
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
      await connect();
    })();
    return startPromise;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearRestart();
    if (chatsReload) clearTimeout(chatsReload);
    for (const timer of [...typingStarts.values(), ...typingStops.values(), ...incomingTyping.values(), ...receiptChecks]) clearTimeout(timer);
    typingStarts.clear();
    typingStops.clear();
    incomingTyping.clear();
    receiptChecks.clear();
    historyLoads.clear();
    imageCache.clear();
    imageCacheBytes = 0;
    for (const load of [...queuedImageLoads.splice(0), ...activeImageLoads.values()]) load.reject(new Error("Session is closed"));
    activeImageLoads.clear();
    imageLoads.clear();
    readRequests.clear();
    const active = client;
    client = undefined;
    await active?.close().catch(() => undefined);
    listeners.clear();
    effects.clear();
    await journal.flush();
  }

  function clearTyping(chatGuid: ChatGuid): void {
    clearTimer(typingStarts, chatGuid);
    clearTimer(typingStops, chatGuid);
    const active = client;
    if (bridge() && active) track(active.typing(chatGuid, false)).catch(() => undefined);
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
