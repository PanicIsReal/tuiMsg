import { useRef } from "react";
import { useMouse } from "./mouse.tsx";
import { Box, Text, type DOMElement } from "ink";
import { chatActivity, type Chat } from "../domain/model.ts";
import type { ChatGuid } from "../domain/ids.ts";
import { ListRow } from "./ListRow.tsx";
import { colors } from "./theme.ts";
import { useStableCallback } from "./stable.ts";
import { formatClock, formatMonthDay, formatWeekday } from "../domain/dates.ts";

export type ListProps = {
  chats: Chat[]; selected: ChatGuid | null; cursor: ChatGuid | null; search: string;
  focused: boolean; width: number; height: number; status: "loading" | "ready" | "error";
  onOpen: (chatGuid: ChatGuid) => void; onMove: (delta: number) => void;
};
const HEADER = 4;
export function List(props: ListProps) {
  const element = useRef<DOMElement>(null);
  const open = useStableCallback(props.onOpen);
  useMouse(element, event => {
    if (event.kind !== "wheel" || !props.focused) return false;
    props.onMove(event.direction === "up" ? -1 : 1);
    return true;
  });
  const count = Math.max(1, Math.floor((props.height - HEADER) / 3));
  const cursor = Math.max(0, props.chats.findIndex(chat => chat.guid === props.cursor));
  // The window holds still and scrolls only when the cursor would leave it, so a move redraws
  // two rows rather than every row, which over SSH is most of a keypress.
  const first = useRef(0);
  const start = Math.max(0, Math.min(cursor < first.current ? cursor : cursor >= first.current + count ? cursor - count + 1 : first.current, props.chats.length - count));
  first.current = start;
  const visible = props.chats.slice(start, start + count);
  const empty = props.status === "loading" ? "Loading conversations…" : props.status === "error" ? "Could not load · Shift+R retries" : props.search ? "No matching conversations" : "No conversations";
  return <Box ref={element} width={props.width} height={props.height} flexShrink={0} backgroundColor={colors.sidebar} flexDirection="column">
    <Box height={HEADER} paddingTop={1} flexShrink={0} paddingX={2} flexDirection="column">
      <Text bold color={colors.text}>Messages</Text>
      <Text wrap="truncate-end" color={props.search ? colors.text : colors.subtle}>{props.search ? `/ ${props.search}` : "/ Search"}</Text>
    </Box>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {props.status !== "ready" || !props.chats.length ? <Box paddingX={2}><Text color={props.status === "error" ? colors.failed : colors.subtle}>{empty}</Text></Box> : null}
      {visible.map(chat => <ListRow chatGuid={chat.guid} key={chat.guid} title={chat.title} preview={chat.lastMessage?.body ?? ""} time={formatTime(chatActivity(chat))} unread={chat.unreadCount > 0} cursor={chat.guid === (props.focused ? props.cursor : props.selected)} focused={props.focused} sms={chat.service === "SMS"} width={props.width} onOpen={open} />)}
    </Box>
  </Box>;
}
function formatTime(ms: number): string {
  if (!ms) return "";
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return formatClock(ms);
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return formatWeekday(ms);
  return formatMonthDay(ms);
}
