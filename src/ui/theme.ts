export const colors = {
  canvas: "#000000",
  listBg: "#1C1C1E",
  listSelected: "#2C2C2E",
  incoming: "#26262A",
  outgoingIMessage: "#007AFF",
  outgoingSms: "#34C759",
  text: "#FFFFFF",
  textOnBubble: "#FFFFFF",
  secondary: "#8E8E93",
  unread: "#007AFF",
  border: "#38383A",
  composer: "#1C1C1E",
  failed: "#FF453A",
} as const;

export function outgoingColor(service: "iMessage" | "SMS"): string {
  return service === "SMS" ? colors.outgoingSms : colors.outgoingIMessage;
}

export const glyph = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
} as const;
