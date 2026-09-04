import type { Chat } from "../domain/model.ts";
import { ListRow } from "./ListRow.tsx";
import { colors } from "./theme.ts";

export type ListProps = {
  chats: Chat[]
  selected: string | null
  search: string
  searchFocused: boolean
};

function formatTime(ms: number): string {
  if (ms === 0) return "";
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function List(props: ListProps) {
  return (
    <box
      width={32}
      height="100%"
      backgroundColor={colors.listBg}
      border
      borderColor={colors.border}
      flexDirection="column"
    >
      <box height={3} paddingLeft={1} paddingRight={1} flexDirection="column">
        <text>
          <strong fg={colors.text}>
            Messages
          </strong>
        </text>
        <text>
          <span fg={colors.secondary}>{props.searchFocused || props.search ? `/${props.search}` : "Search  /"}</span>
        </text>
      </box>
      <scrollbox flexGrow={1} stickyScroll stickyStart="top">
        {props.chats.map((chat) => (
          <ListRow
            key={chat.guid}
            title={chat.title}
            preview={chat.lastMessage?.body ?? ""}
            time={formatTime(chat.lastMessage?.sentAt ?? 0)}
            unread={chat.unreadCount > 0}
            selected={chat.guid === props.selected}
            sms={chat.service === "SMS"}
          />
        ))}
      </scrollbox>
    </box>
  );
}
