import { Box, Text } from "ink";
import { colors } from "./theme.ts";

const LINES = [
  "j/k ↑/↓ move · Enter open/send",
  "i compose · Esc back · Tab panes",
  "Ctrl+J newline · Enter sends",
  "y copy · r reply · t react",
  "a files · v image · o open · s save",
  "! retry · g older · m retry read",
  "/ search · n new · PgUp/PgDn scroll",
  "? help · q quit",
] as const;

export function Help(props: { width: number; height: number }) {
  return <Box borderStyle="round" borderBackgroundColor={colors.canvas} borderColor={colors.accent} backgroundColor={colors.panelRaised}
    paddingX={1} flexDirection="column" width={props.width} height={props.height} maxWidth="100%" maxHeight="100%" overflow="hidden">
    <Box height={1} flexShrink={0}><Text bold color={colors.text}>Keyboard shortcuts</Text></Box>
    {LINES.map(line => <Box key={line} height={1} flexShrink={0}><Text wrap="truncate-end" color={colors.text}>{line}</Text></Box>)}
  </Box>;
}
