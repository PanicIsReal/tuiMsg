import { describe, expect, it } from "vitest";
import { childConnector, ImsgMissingError, RpcClosedError, RpcConnection, RpcError, RpcNotSentError, RpcTimeoutError, type RpcConnector, type RpcEvents } from "../../src/imsg/rpc.ts";

function manual(): { connector: RpcConnector; written: Record<string, unknown>[]; events: () => RpcEvents } {
  const written: Record<string, unknown>[] = [];
  let events: RpcEvents | undefined;
  const connector: RpcConnector = (handlers) => {
    events = handlers;
    return { write: (line) => { written.push(JSON.parse(line) as Record<string, unknown>); }, close: async () => undefined };
  };
  return { connector, written, events: () => events! };
}

// A tiny stand-in for `imsg rpc` that echoes requests and can crash on demand.
const ECHO = `
const lines = require("readline").createInterface({ input: process.stdin });
process.stderr.write("Could not fetch group 1 :ABGroup\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "crash") { process.stderr.write("fatal: database is locked\\n"); process.exit(3); }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { seen: request.method } }) + "\\n");
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { method: request.method, params: request.params } }) + "\\n");
});
`;

describe("RpcConnection", () => {
  it("matches out-of-order responses and routes notifications", async () => {
    const { connector, written, events } = manual();
    const rpc = new RpcConnection(connector);
    const notifications: unknown[] = [];
    rpc.onNotification((method, params) => notifications.push({ method, params }));
    const first = rpc.request("chats.list", { limit: 1 });
    const second = rpc.request("status");
    expect(written.map((request) => request.method)).toEqual(["chats.list", "status"]);
    events().line(JSON.stringify({ jsonrpc: "2.0", id: written[1]!.id, result: "second" }));
    events().line(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1 } }));
    events().line("not json");
    events().line(JSON.stringify({ jsonrpc: "2.0", id: written[0]!.id, result: "first" }));
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(notifications).toEqual([{ method: "message", params: { subscription: 1 } }]);
  });

  it("surfaces JSON-RPC errors with their code and structured data", async () => {
    const { connector, written, events } = manual();
    const rpc = new RpcConnection(connector);
    const pending = rpc.request("send", { text: "hi" });
    events().line(JSON.stringify({ jsonrpc: "2.0", id: written[0]!.id, error: { code: -32001, message: "Delivery outcome unknown", data: { disposition: "may_have_completed" } } }));
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: -32001, data: { disposition: "may_have_completed" } });
  });

  it("times out a request that imsg never answers", async () => {
    const { connector } = manual();
    const rpc = new RpcConnection(connector, 20);
    await expect(rpc.request("status")).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("rejects pending and later requests once the child exits", async () => {
    const { connector, events } = manual();
    const rpc = new RpcConnection(connector);
    const exits: Error[] = [];
    rpc.onExit((error) => exits.push(error));
    const pending = rpc.request("status");
    events().exit(new RpcClosedError("imsg stopped (exit 1)"));
    await expect(pending).rejects.toThrow("imsg stopped");
    await expect(rpc.request("status")).rejects.toBeInstanceOf(RpcNotSentError);
    expect(exits).toHaveLength(1);
    expect(rpc.closed).toBe(true);
  });
});

describe("childConnector", () => {
  it("speaks NDJSON with a real child and keeps its stderr off the terminal", async () => {
    const rpc = new RpcConnection(childConnector(process.execPath, ["-e", ECHO]));
    const seen: unknown[] = [];
    rpc.onNotification((_method, params) => seen.push(params));
    await expect(rpc.request("chats.list", { limit: 2 })).resolves.toEqual({ method: "chats.list", params: { limit: 2 } });
    expect(seen).toEqual([{ seen: "chats.list" }]);
    await rpc.close();
  });

  it("reports the child's last meaningful stderr line when it dies", async () => {
    const rpc = new RpcConnection(childConnector(process.execPath, ["-e", ECHO]));
    const exited = new Promise<Error>((resolve) => rpc.onExit(resolve));
    await expect(rpc.request("crash")).rejects.toThrow(/database is locked/);
    expect((await exited).message).toMatch(/exit 3.*database is locked/);
  });

  it("explains how to install imsg when the binary is missing", async () => {
    const rpc = new RpcConnection(childConnector("/nonexistent/imsg", ["rpc"]));
    const error = await rpc.request("status").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImsgMissingError);
    expect((error as Error).message).toMatch(/brew install steipete\/tap\/imsg/);
  });
});
