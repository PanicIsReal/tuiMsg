import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { benchmark } from "../benchmark.ts";

// JSON-RPC 2.0 over newline-delimited JSON, as spoken by `imsg rpc` on stdin/stdout.

export type RpcEvents = { line: (line: string) => void; exit: (error: Error) => void };
export type RpcTransport = { write: (line: string) => void; close: () => Promise<void> };
export type RpcConnector = (events: RpcEvents) => RpcTransport;
export type NotificationListener = (method: string, params: unknown) => void;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

// The request may still be running inside imsg; callers decide whether that is ambiguous.
export class RpcTimeoutError extends Error {
  constructor(method: string) {
    super(`imsg did not answer ${method} in time`);
    this.name = "RpcTimeoutError";
  }
}

export class RpcClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcClosedError";
  }
}

// Refused before being written, so it certainly did not run.
export class RpcNotSentError extends RpcClosedError {
  constructor(message: string) {
    super(message);
    this.name = "RpcNotSentError";
  }
}

export class ImsgMissingError extends RpcClosedError {
  constructor(command: string) {
    super(`imsg was not found (${command}). Install it on this Mac with: brew install steipete/tap/imsg`);
    this.name = "ImsgMissingError";
  }
}

type Pending = { method: string; sent: number; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class RpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private readonly transport: RpcTransport;
  private failure: Error | undefined;

  constructor(connect: RpcConnector, private readonly timeoutMs = 30_000) {
    this.transport = connect({ line: (line) => this.receive(line), exit: (error) => this.fail(error) });
  }

  get closed(): boolean { return this.failure !== undefined; }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.failure) return Promise.reject(new RpcNotSentError(this.failure.message));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (benchmark.on) benchmark.request(method, timeoutMs, 0, "timed out");
        reject(new RpcTimeoutError(method));
      }, timeoutMs);
      this.pending.set(id, { method, sent: performance.now(), resolve: resolve as (value: unknown) => void, reject, timer });
      this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => { this.notificationListeners.delete(listener); };
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  async close(): Promise<void> {
    if (!this.failure) this.fail(new RpcClosedError("imsg connection closed"), false);
    await this.transport.close();
  }

  private receive(line: string): void {
    let record: unknown;
    try { record = JSON.parse(line); } catch { return; }
    if (typeof record !== "object" || record === null || Array.isArray(record)) return;
    const message = record as Record<string, unknown>;
    if (typeof message.method === "string" && !("id" in message)) {
      if (benchmark.on) benchmark.event(message.method, Buffer.byteLength(line));
      for (const listener of this.notificationListeners) listener(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const failed = typeof message.error === "object" && message.error !== null;
    if (benchmark.on) benchmark.request(pending.method, performance.now() - pending.sent, Buffer.byteLength(line), failed ? "error" : undefined);
    if (failed) {
      const error = message.error as Record<string, unknown>;
      pending.reject(new RpcError(typeof error.code === "number" ? error.code : -32603, typeof error.message === "string" ? error.message : "imsg request failed", error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error, notify = true): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (benchmark.on) benchmark.request(pending.method, performance.now() - pending.sent, 0, "failed");
      pending.reject(error);
    }
    this.pending.clear();
    if (notify) for (const listener of this.exitListeners) listener(error);
  }
}

export function childConnector(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): RpcConnector {
  return (events) => {
    // Pipe all three streams: imsg must never write to the terminal the TUI owns.
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    let stderr = "";
    let exited = false;
    const exit = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += decoder.write(chunk);
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) events.line(line);
        newline = buffered.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000); });
    child.stdin.on("error", () => undefined);
    const finish = (error: Error) => {
      if (exited) return;
      exited = true;
      events.exit(error);
    };
    child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? new ImsgMissingError(command) : error));
    child.once("close", (code, signal) => {
      const detail = lastLine(stderr);
      finish(new RpcClosedError(`imsg stopped (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : ""}`));
    });
    return {
      write(line) { if (!exited && child.stdin.writable) child.stdin.write(line); },
      async close() {
        // imsg drains accepted work and exits when stdin closes.
        if (!exited) child.stdin.end();
        const timer = setTimeout(() => { if (!exited) child.kill("SIGTERM"); }, 2_000);
        await exit;
        clearTimeout(timer);
      },
    };
  };
}

function lastLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !/Could not fetch group .*ABGroup/.test(line)).at(-1) ?? "";
}
