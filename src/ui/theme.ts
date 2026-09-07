import chalk from "chalk";

const neutral = {
  canvas: "#151515", panel: "#151515", panelRaised: "#1C1C1C", selected: "#262626",
  incoming: "#151515", outgoingIMessage: "#C6C6C6", outgoingSms: "#A8A8A8",
  text: "#E4E4E4", textOnBubble: "#E4E4E4", secondary: "#929292", subtle: "#707070",
  accent: "#D0D0D0", border: "#383838", bubbleBorder: "#383838", focus: "#D0D0D0",
  failed: "#D98C8C", warning: "#C8B58B", sms: "#A8A8A8",
} as const;

export function paletteForColorLevel(level: number): Record<keyof typeof neutral, string> {
  if (level >= 2) return neutral;
  return {
    canvas: "black", panel: "black", panelRaised: "black", selected: "black",
    incoming: "black", outgoingIMessage: "white", outgoingSms: "gray",
    text: "whiteBright", textOnBubble: "whiteBright", secondary: "white", subtle: "gray",
    accent: "whiteBright", border: "gray", bubbleBorder: "gray", focus: "whiteBright",
    failed: "redBright", warning: "yellow", sms: "white",
  };
}

export const colors = paletteForColorLevel(chalk.level);

export const reactionGlyph = {
  love: "♥", like: "+1", dislike: "-1", laugh: "Ha", emphasize: "!!", question: "?",
} as const;
