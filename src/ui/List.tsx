import { useRef } from "react";
import { useMouse } from "./mouse.tsx";
import { Box, Text, type DOMElement } from "ink";
import { chatActivity, type Chat } from "../domain/model.ts";
import type { ChatGuid } from "../domain/ids.ts";
import { ListRow } from "./ListRow.tsx";
import { colors } from "./theme.ts";

export type ListProps = {
  chats: Chat[]; selected: ChatGuid | null; cursor: ChatGuid | null; search: string;
  focused: boolean; width: number; height: number; status: "loading" | "ready" | "error";
  onOpen: (chatGuid: ChatGuid) => void; onMove: (delta: number) => void;
};
export function List(props: ListProps) {
  const element = useRef<DOMElement>(null);
  useMouse(element, event => {
    if (event.kind !== "wheel" || !props.focused) return false;
    props.onMove(event.direction === "up" ? -1 : 1);
    return true;
  });
  const count = Math.max(1, Math.floor((props.height - 5) / 3));
  const cursor = Math.max(0, props.chats.findIndex(chat => chat.guid === props.cursor));
  const start = Math.max(0, Math.min(cursor - Math.floor(count / 2), props.chats.length - count));
  const visible = props.chats.slice(start, start + count);
  return <Box ref={element} width={props.width} height={props.height} flexShrink={0} borderStyle="single" borderBackgroundColor={colors.canvas} borderTop={false} borderBottom={false} borderLeft={false} borderColor={colors.border} flexDirection="column">
    <Box height={4} paddingTop={1} flexShrink={0} paddingX={1} flexDirection="column">
      <Text bold color={colors.text}>Messages</Text>
      <Text wrap="truncate-end" color={props.search ? colors.accent : colors.secondary}>{props.search ? `/${props.search}` : "/ search    n new"}</Text>
    </Box>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {props.status !== "ready" || !props.chats.length ? <Box padding={1}><Text color={props.status === "error" ? colors.failed : colors.secondary}>{props.status === "loading" ? "Loading conversations…" : props.status === "error" ? "Could not load · press R" : props.search ? "No matching conversations" : "No conversations"}</Text></Box> : null}
      {visible.map(chat => <ListRow id={`chat-${chat.guid}`} key={chat.guid} title={chat.title} preview={chat.lastMessage?.body ?? ""} time={formatTime(chatActivity(chat))} unread={chat.unreadCount > 0} active={chat.guid === props.selected} cursor={chat.guid === (props.focused ? props.cursor : props.selected)} sms={chat.service === "SMS"} width={props.width} onOpen={() => props.onOpen(chat.guid)} />)}
    </Box>
    <Box height={1} paddingX={1}><Text color={colors.subtle}>{props.chats.length ? `${start + 1}–${start + visible.length} of ${props.chats.length}` : " "}</Text></Box>
  </Box>;
}
function formatTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
