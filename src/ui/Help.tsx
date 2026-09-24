import { Box, Text } from "ink";
import { colors } from "./theme.ts";

const KEYS: [string, string][] = [
  ["j k", "move"], ["↵", "open · send"],
  ["i", "write"], ["esc", "back"],
  ["tab", "next pane"], ["^J", "new line"],
  ["r", "reply"], ["t", "react"],
  ["y", "copy"], ["v", "view image"],
  ["o", "open link"], ["s", "save file"],
  ["a", "attachments"], ["g", "older"],
  ["!", "retry send"], ["m", "retry read"],
  ["/", "search"], ["n", "new chat"],
  ["PgUp", "scroll"], ["L", "light / dark"],
  ["?", "help"], ["q", "quit"],
];
const KEY = 5;
const LABEL = 12;

// Two columns of key and action when there is room, one otherwise.
export function Help(props: { width: number; height: number }) {
  const columns = props.width - 6 >= (KEY + LABEL) * 2 + 3 ? 2 : 1;
  const rows: [string, string][][] = [];
  for (let index = 0; index < KEYS.length; index += columns) rows.push(KEYS.slice(index, index + columns));
  return <Box borderStyle="round" borderBackgroundColor={colors.canvas} borderColor={colors.faint} backgroundColor={colors.raised}
    paddingX={2} flexDirection="column" width={props.width} height={props.height} maxWidth="100%" maxHeight="100%" overflow="hidden">
    <Box height={1} flexShrink={0} marginBottom={props.height > 13 ? 1 : 0}><Text bold color={colors.text}>Keyboard shortcuts</Text></Box>
    {rows.map((row) => <Box key={row[0]![0]} height={1} flexShrink={0} flexDirection="row">
      {row.map(([key, label], index) => <Box key={key} width={KEY + LABEL + (index ? 0 : 3)} flexShrink={0}>
        <Box width={KEY} flexShrink={0}><Text color={colors.text}>{key}</Text></Box><Text wrap="truncate-end" color={colors.subtle}>{label}</Text>
      </Box>)}
    </Box>)}
  </Box>;
}
