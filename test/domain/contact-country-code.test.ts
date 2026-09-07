import { describe, expect, it } from "vitest";
import { parseChatGuid, parseHandleAddress, parseMessageGuid } from "../../src/domain/ids.ts";
import { emptyState, type Contact } from "../../src/domain/model.ts";
import { reduce } from "../../src/domain/reduce.ts";

function contact(displayName: string, ...phones: string[]): Contact {
  return { displayName, phones: phones.map(parseHandleAddress), emails: [] };
}

function resolve(address: string, contacts: Contact[]) {
  const guid = parseChatGuid(`iMessage;-;${address}`);
  const handle = { address: parseHandleAddress(address), service: "iMessage" as const };
  let state = reduce(emptyState(), { type: "chats-loaded", chats: [{
    guid, kind: "dm", service: "iMessage", title: address, participants: [handle], unreadCount: 0, muted: false,
  }] });
  state = reduce(state, { type: "messages-loaded", chatGuid: guid, messages: [{
    guid: parseMessageGuid("synthetic-message"), chatGuid: guid, kind: "text", from: handle,
    isFromMe: false, body: "Hello", attachments: [], sentAt: 1, status: "sent",
  }] });
  state = reduce(state, { type: "contacts-loaded", contacts });
  return { state, guid, chat: state.chats.get(guid)!, message: state.messages.get(guid)![0]! };
}

describe("North American contact matching", () => {
  const variants = ["7805550123", "+7805550123", "17805550123", "+17805550123", "(780) 555-0123", "+1 (780) 555-0123"];
  it.each(variants.flatMap(address => variants.map(stored => [address, stored])))("matches %s to %s without changing the address", (address, stored) => {
    const result = resolve(address, [contact("Sam", stored)]);
    expect(result.chat.title).toBe("Sam");
    expect(result.chat.participants[0]?.address).toBe(address);
    expect(result.message.kind === "text" && result.message.from.contact?.displayName).toBe("Sam");
    expect(result.message.kind === "text" && result.message.from.address).toBe(address);
  });

  it("prefers an exact match over a country-code fallback", () => {
    expect(resolve("+15552345678", [contact("Exact", "+15552345678"), contact("Local", "5552345678")]).chat.title).toBe("Exact");
  });

  it("prefers an exact +local match over a competing normalized contact", () => {
    expect(resolve("+7805550123", [contact("Exact", "+7805550123"), contact("Other", "17805550123")]).chat.title).toBe("Exact");
  });

  it("leaves conflicting fallback contacts unresolved", () => {
    expect(resolve("+15552345678", [contact("First", "5552345678"), contact("Second", "15552345678")]).chat.title).toBe("+15552345678");
  });

  it("leaves local fallback ambiguous across distinct contacts", () => {
    expect(resolve("+17805550123", [contact("First", "+7805550123"), contact("Second", "7805550123")]).chat.title).toBe("+17805550123");
  });

  it.each(["+7805550123", "+17805550123"])("resolves duplicate cards when equivalent names agree for %s", (address) => {
    for (const contacts of [[contact("Sam", "(780) 555-0123"), contact(" Sam ", "1(780)555-0123")], [contact(" Sam ", "1(780)555-0123"), contact("Sam", "(780) 555-0123")]]) {
      const result = resolve(address, contacts);
      expect(result.chat.title).toBe("Sam");
      expect(result.chat.participants[0]?.address).toBe(address);
      expect(result.message.kind === "text" && result.message.from.contact?.displayName.trim()).toBe("Sam");
      expect(result.message.kind === "text" && result.message.from.address).toBe(address);
    }
  });

  it("allows multiple equivalent numbers on the same contact", () => {
    expect(resolve("+15552345678", [contact("Sam", "5552345678", "15552345678")]).chat.title).toBe("Sam");
  });

  it("clears a previous fallback when a later contact makes it ambiguous", () => {
    const { state, guid } = resolve("+15552345678", [contact("First", "5552345678")]);
    const next = reduce(state, { type: "contacts-loaded", contacts: [contact("Second", "15552345678")] });
    expect(next.chats.get(guid)?.title).toBe("+15552345678");
    expect(next.chats.get(guid)?.participants[0]?.contact).toBeUndefined();
    const message = next.messages.get(guid)?.[0];
    expect(message?.kind === "text" && message.from.contact).toBeUndefined();
  });

  it("does not match arbitrary international suffixes", () => {
    expect(resolve("+445552345678", [contact("Sam", "5552345678")]).chat.title).toBe("+445552345678");
    expect(resolve("+77805550123", [contact("Sam", "7805550123")]).chat.title).toBe("+77805550123");
  });
});
