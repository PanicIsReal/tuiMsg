import { describe, expect, it } from "vitest";
import { parseChatGuid, parseMessageGuid } from "../../src/domain/ids.ts";
import { BackendError, backendError, ImsgClient } from "../../src/imsg/client.ts";
import { FakeImsg } from "../../src/imsg/fake.ts";
import { RpcClosedError, RpcConnection, RpcError, RpcNotSentError, RpcTimeoutError } from "../../src/imsg/rpc.ts";

const chatGuid = parseChatGuid("iMessage;-;+15551230001");

function client(fake: FakeImsg): ImsgClient {
  return new ImsgClient(new RpcConnection(fake.connect()));
}

describe("backend errors", () => {
  it("treats only operations that may have run as ambiguous", () => {
    expect(backendError(new RpcError(-32001, "Delivery outcome unknown", { disposition: "may_have_completed" }), true)).toMatchObject({ kind: "failed", ambiguous: true });
    expect(backendError(new RpcError(-32603, "Delivery failed before dispatch", { disposition: "not_started", detail: "Not authorized to send Apple events to Messages." }), true))
      .toMatchObject({ kind: "failed", ambiguous: false, message: "Delivery failed before dispatch: Not authorized to send Apple events to Messages." });
    expect(backendError(new RpcError(-32004, "Mutation lane blocked", { disposition: "still_in_flight" }), true)).toMatchObject({ kind: "blocked", ambiguous: false });
    expect(backendError(new RpcTimeoutError("send"), true)).toMatchObject({ kind: "failed", ambiguous: true });
    expect(backendError(new RpcTimeoutError("messages.history"), false)).toMatchObject({ ambiguous: false });
    expect(backendError(new RpcClosedError("imsg stopped (exit 1)"), true)).toMatchObject({ kind: "stopped", ambiguous: true });
    expect(backendError(new RpcNotSentError("imsg stopped (exit 1)"), true)).toMatchObject({ kind: "stopped", ambiguous: false });
  });

  it("classifies access, bridge, and parameter errors", () => {
    expect(backendError(new RpcError(-32002, "Database unavailable", { detail: "unable to open database file" }), false)).toMatchObject({ kind: "access", message: "Database unavailable: unable to open database file" });
    expect(backendError(new RpcError(-32003, "Bridge unavailable"), true)).toMatchObject({ kind: "unsupported" });
    expect(backendError(new RpcError(-32601, "Method not found"), false)).toMatchObject({ kind: "unsupported" });
    expect(backendError(new RpcError(-32602, "Invalid params", "unknown chat_id 9"), false)).toMatchObject({ kind: "invalid", message: "Invalid params: unknown chat_id 9" });
  });
});

describe("ImsgClient against the fake", () => {
  it("pages history newest first with an exclusive end bound", async () => {
    const fake = new FakeImsg({
      chats: [{ id: 1, guid: chatGuid, identifier: "+15551230001", service: "iMessage", is_group: false, participants: ["+15551230001"], unread_count: 0 }],
      messages: [1, 2, 2, 3].map((second, index) => ({ id: index + 1, chat_id: 1, guid: `m${index + 1}`, sender: "+15551230001", is_from_me: false, text: `t${index + 1}`, created_at: second * 1000 })),
    });
    const imsg = client(fake);
    const first = await imsg.history(1, { limit: 2 });
    expect(first.records.map((record) => record.messages[0]?.guid)).toEqual(["m4", "m3"]);
    const older = await imsg.history(1, { limit: 2, before: 2000 });
    expect(older.records.map((record) => record.messages[0]?.guid)).toEqual(["m1"]);
    expect(fake.requests.at(-1)?.params).toMatchObject({ chat_id: 1, limit: 2, end: new Date(2000).toISOString(), attachments: true });
    await imsg.close();
  });

  it("returns the GUID Messages recorded for a send", async () => {
    const fake = new FakeImsg();
    const imsg = client(fake);
    const result = await imsg.sendText({ chatGuid, text: "hello" });
    expect(result.guid).toBe(fake.messages.at(-1)?.guid);
    expect(fake.requests.at(-1)).toEqual({ method: "send", params: { chat_guid: chatGuid, text: "hello" } });
    await imsg.close();
  });

  it("refuses bridge-only tapbacks without the bridge", async () => {
    const imsg = client(new FakeImsg({ bridge: false }));
    const error = await imsg.tapback({ chatGuid, messageGuid: parseMessageGuid("m0"), reaction: "emphasize", remove: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ kind: "unsupported", ambiguous: false });
    await imsg.close();
  });

  it("sends the imsg spelling of emphasis through the bridge", async () => {
    const fake = new FakeImsg({ bridge: true });
    const imsg = client(fake);
    await imsg.tapback({ chatGuid, messageGuid: parseMessageGuid("m0"), reaction: "emphasize", remove: false });
    expect(fake.requests.at(-1)?.params).toMatchObject({ chat_guid: chatGuid, message_guid: "m0", reaction: "emphasis", remove: false });
    await imsg.close();
  });
});
