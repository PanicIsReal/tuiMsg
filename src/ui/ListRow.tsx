import { useMouse } from "./mouse.tsx";
import { Box, Text, type DOMElement } from "ink";
import { memo, useRef } from "react";
import { colors, useTheme } from "./theme.ts";
import type { ChatGuid } from "../domain/ids.ts";

export type ListRowProps = {
  chatGuid: ChatGuid;
  title: string;
  preview: string;
  time: string;
  unread: boolean;
  // The row under the cursor, which is also the conversation shown, or the open conversation
  // while the list is not focused.
  cursor: boolean;
  focused: boolean;
  sms: boolean;
  width: number;
  // Stable across renders, so the memo holds: each row passes its own conversation.
  onOpen: (chatGuid: ChatGuid) => void;
};

export const ListRow = memo(function ListRow(props: ListRowProps) {
  useTheme();
  const element = useRef<DOMElement>(null);
  useMouse(element, event => {
    if (event.kind !== "click" || event.button !== "left") return false;
    props.onOpen(props.chatGuid);
    return true;
  });
  // Column 0 carries the row's state: a bar for the selection, else a dot for unread.
  const dot = props.unread && !props.cursor;
  const bar = props.cursor ? "▎" : " ";
  const barColor = props.cursor ? props.focused ? colors.accent : colors.subtle : colors.faint;
  const contentWidth = Math.max(1, props.width - 3);
  const service = props.sms ? "SMS " : "";
  const titleWidth = Math.max(1, contentWidth - props.time.length - service.length - 1);
  const title = (props.title || "Unknown").replace(/[\r\n\t]/g, " ");
  const preview = normalizePreview(props.preview);
  return (
    <Box ref={element} height={3} flexShrink={0} width="100%" flexDirection="column">
      <Box height={2} flexShrink={0} flexDirection="column" backgroundColor={props.cursor ? colors.raised : colors.sidebar}>
        <Box height={1} flexShrink={0} flexDirection="row">
          <Text color={dot ? colors.accent : barColor}>{dot ? "●" : bar} </Text>
          <Box flexGrow={1} flexDirection="row" justifyContent="space-between" paddingRight={1}>
            <Text wrap="truncate-end" bold={props.unread} color={colors.text}>{truncateEnd(title, titleWidth)}</Text>
            <Text wrap="truncate-end"><Text color={colors.sms}>{service}</Text><Text color={props.unread ? colors.accent : colors.subtle}>{props.time}</Text></Text>
          </Box>
        </Box>
        <Box height={1} flexShrink={0} flexDirection="row">
          <Text color={barColor}>{bar} </Text>
          <Text wrap="truncate-end" color={props.unread ? colors.secondary : colors.subtle}>{truncateEnd(preview, contentWidth)}</Text>
        </Box>
      </Box>
    </Box>
  );
});

function normalizePreview(value: string): string {
  const text = value.replace(/￼/g, "").replace(/[\r\n\t]+/g, " ").trim();
  // Previews load after the list; an empty one is still on its way.
  return text || (value.includes("￼") ? "Attachment" : "");
}

// Slice by code point so an emoji at the cut is dropped whole rather than split into "�".
function truncateEnd(value: string, width: number): string {
  const characters = Array.from(value);
  if (characters.length <= width) return value;
  if (width <= 1) return "…";
  return `${characters.slice(0, width - 1).join("")}…`;
}
