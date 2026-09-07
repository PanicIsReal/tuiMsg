import type { ChatGuid } from "./ids.ts";
import type { Chat, Message, Reaction, TapbackChip, TextMessage } from "./model.ts";

export type ThreadRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: Exclude<Message, { kind: "tapback" }>; chips: TapbackChip[] };

const CHIP_ORDER: Reaction[] = ["love", "like", "dislike", "laugh", "emphasize", "question"];

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function foldTapbacks(messages: Message[]): ThreadRow[] {
  const memberships = new Map<string, Map<Reaction, Map<string, boolean>>>();
  for (const message of messages) {
    if (message.kind !== "tapback") continue;
    const bucket = memberships.get(message.target) ?? new Map();
    const senders = bucket.get(message.reaction) ?? new Map();
    if (message.removed) {
      senders.delete(message.from.address);
    } else {
      senders.set(message.from.address, message.isFromMe);
    }
    if (senders.size === 0) bucket.delete(message.reaction);
    else bucket.set(message.reaction, senders);
    memberships.set(message.target, bucket);
  }

  const rows: ThreadRow[] = [];
  let lastDay = "";
  for (const message of messages) {
    if (message.kind === "tapback") continue;
    const key = dayKey(message.sentAt);
    if (key !== lastDay) {
      rows.push({ kind: "day", key: `day-${key}`, label: dayLabel(message.sentAt) });
      lastDay = key;
    }
    const chipMap = memberships.get(message.guid);
    const list: TapbackChip[] = [];
    if (chipMap) {
      for (const reaction of CHIP_ORDER) {
        const senders = chipMap.get(reaction);
        if (senders) list.push({ reaction, count: senders.size, fromMe: [...senders.values()].some(Boolean) });
      }
    }
    rows.push({ kind: "message", key: message.guid, message, chips: list });
  }
  return rows;
}

export function sortedChats(chats: Map<ChatGuid, Chat>, query: string): Chat[] {
  const q = query.trim().toLowerCase();
  const list = [...chats.values()];
  const filtered =
    q.length === 0
      ? list
      : list.filter((chat) => {
          if (chat.title.toLowerCase().includes(q)) return true;
          const preview = chat.lastMessage?.body.toLowerCase() ?? "";
          return preview.includes(q);
        });
  return filtered.toSorted((a, b) => (b.lastMessage?.sentAt ?? 0) - (a.lastMessage?.sentAt ?? 0));
}

export function lastOwnReceipt(messages: Message[]): TextMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.kind === "text" && message.isFromMe) return message;
  }
  return undefined;
}

export function sameSender(a: Message, b: Message): boolean {
  if (!("from" in a) || !("from" in b)) return false;
  return a.from.address === b.from.address && a.isFromMe === b.isFromMe;
}
