import { colors } from "./theme.ts";

const LINES = [
  "j/k  move list     Enter  open chat     i  composer",
  "Esc  message cursor   r reply   t tapback   y copy",
  "/ search    n new    ? help    q quit",
  "Tab cycle panes     Shift+Enter newline",
] as const;

export function Help() {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={colors.unread}
      backgroundColor={colors.listBg}
      padding={1}
      flexDirection="column"
    >
      <text>
        <strong fg={colors.text}>
          imsg
        </strong>
      </text>
      {LINES.map((line) => (
        <text key={line}>
          <span fg={colors.secondary}>{line}</span>
        </text>
      ))}
    </box>
  );
}
