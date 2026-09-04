export type ChatGuid = string & { readonly __brand: "ChatGuid" };
export type MessageGuid = string & { readonly __brand: "MessageGuid" };
export type HandleAddress = string & { readonly __brand: "HandleAddress" };

const CHAT_GUID = /^[A-Za-z]+;[+\-];.+$/;

export function parseChatGuid(input: string): ChatGuid {
  if (!CHAT_GUID.test(input)) {
    throw new Error(`invalid chat guid: ${input}`);
  }
  return input as ChatGuid;
}

export function parseMessageGuid(input: string): MessageGuid {
  if (input.length === 0) {
    throw new Error("invalid message guid");
  }
  return input as MessageGuid;
}

export function parseHandleAddress(input: string): HandleAddress {
  if (input.length === 0) {
    throw new Error("invalid handle address");
  }
  return input as HandleAddress;
}

export function encodeChatPath(guid: ChatGuid): string {
  return encodeURIComponent(guid);
}
