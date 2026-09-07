import { useMouse } from "./mouse.tsx";
import { Box, Text, type DOMElement } from "ink";
import { memo, useRef } from "react";
import { colors } from "./theme.ts";

export type ListRowProps = {
  id: string;
  title: string;
  preview: string;
  time: string;
  unread: boolean;
  active: boolean;
  cursor: boolean;
  sms: boolean;
  width: number;
  onOpen: () => void;
};

export const ListRow = memo(function ListRow(props: ListRowProps) {
  const element = useRef<DOMElement>(null);
  useMouse(element, event => {
    if (event.kind !== "click" || event.button !== "left") return false;
    props.onOpen();
    return true;
  });
  const contentWidth = Math.max(1, props.width - 5);
  const marker = props.cursor ? "›" : props.unread ? "●" : props.active ? "·" : " ";
  const service = props.sms ? "SMS " : "";
  const titleWidth = Math.max(1, contentWidth - props.time.length - service.length - 3);
  const title = (props.title || "Unknown").replace(/[\r\n\t]/g, " ");
  const preview = normalizePreview(props.preview);
  return (
    <Box ref={element} height={3} flexShrink={0} width="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
      <Box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={props.cursor ? colors.text : props.unread ? colors.text : colors.subtle}>{marker} </Text>
          {props.unread || props.cursor ? <Text bold color={colors.text}>{truncateEnd(title, titleWidth)}</Text> : <Text color={colors.text}>{truncateEnd(title, titleWidth)}</Text>}
        </Text>
        <Text wrap="truncate-end"><Text color={colors.sms}>{service}</Text><Text color={colors.secondary}>{props.time}</Text></Text>
      </Box>
      <Text wrap="truncate-end">
        <Text color={colors.secondary}>  {truncateEnd(preview, Math.max(1, contentWidth - 2))}</Text>
      </Text>
    </Box>
  );
});

function normalizePreview(value: string): string {
  const text = value.replace(/\uFFFC/g, "").replace(/[\r\n\t]+/g, " ").trim();
  return text || (value.includes("\uFFFC") ? "Attachment" : "No messages yet");
}

function truncateEnd(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}
