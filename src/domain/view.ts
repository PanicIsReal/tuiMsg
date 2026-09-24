import type { ChatGuid } from "./ids.ts";
import { chatActivity, type Chat, type Message, type Reaction, type TapbackChip, type TextMessage } from "./model.ts";

export type ThreadRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: Exclude<Message, { kind: "tapback" }>; chips: TapbackChip[] };

const CHIP_ORDER: Reaction[] = ["love", "like", "dislike", "laugh", "emphasize", "question"];

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Relative for the last week, like Messages: Today, Yesterday, Monday, then Mon, Sep 22.
export function dayLabel(ms: number, now = Date.now()): string {
  const day = new Date(ms);
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(new Date(now)) - start(day)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return day.toLocaleDateString(undefined, { weekday: "long" });
  if (day.getFullYear() === new Date(now).getFullYear()) return day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function foldTapbacks(messages: Message[]): ThreadRow[] {
  const memberships = new Map<string, Map<string, { chip: Omit<TapbackChip, "count" | "fromMe">; senders: Map<string, boolean> }>>();
  for (const message of messages) {
    if (message.kind !== "tapback") continue;
    const bucket = memberships.get(message.target) ?? new Map();
    const key = message.reaction === "emoji" ? `emoji:${message.emoji ?? ""}` : message.reaction;
    const entry = bucket.get(key) ?? { chip: message.reaction === "emoji" ? { reaction: "emoji", emoji: message.emoji ?? "?" } : { reaction: message.reaction }, senders: new Map() };
    // In a direct chat, Messages records the other person as the handle of your own
    // outgoing rows, so the sender address alone cannot tell your reaction from theirs.
    const sender = message.isFromMe ? "\0me" : message.from.address;
    if (message.removed) entry.senders.delete(sender);
    else entry.senders.set(sender, message.isFromMe);
    if (entry.senders.size === 0) bucket.delete(key);
    else bucket.set(key, entry);
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
      const keys = [...CHIP_ORDER.filter((reaction) => chipMap.has(reaction)), ...[...chipMap.keys()].filter((key) => key.startsWith("emoji:"))];
      for (const key of keys) {
        const entry = chipMap.get(key)!;
        list.push({ ...entry.chip, count: entry.senders.size, fromMe: [...entry.senders.values()].some(Boolean) });
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
  return filtered.toSorted((a, b) => chatActivity(b) - chatActivity(a));
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
