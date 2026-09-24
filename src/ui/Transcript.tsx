import { useMouse } from "./mouse.tsx";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, type DOMElement } from "ink";
import type { Attachment, HistoryState, Message } from "../domain/model.ts";
import type { ChatGuid, MessageGuid } from "../domain/ids.ts";
import { foldTapbacks, lastOwnReceipt, sameSender } from "../domain/view.ts";
import { Bubble } from "./Bubble.tsx";
import { bar, colors, personColor } from "./theme.ts";
import { useStableCallback } from "./stable.ts";

export type TranscriptProps = {
  chatGuid: ChatGuid; title: string; subtitle: { text: string; color: string }; group?: boolean; messages: Message[]; typing: boolean;
  focused: boolean; cursor: MessageGuid | null; history: HistoryState;
  readError: string | null; width: number; height: number;
  onSelect: (messageGuid: MessageGuid) => void;
  onHistory: (mode: "latest" | "older") => void; onRetryRead: () => void;
  loadAttachment?: ((attachment: Attachment) => Promise<Uint8Array>) | undefined;
  onViewAttachment?: ((attachment: Attachment) => void) | undefined;
};
export function Transcript(props: TranscriptProps) {
  const viewport = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const elements = useRef(new Map<MessageGuid, DOMElement>());
  const [scroll, setScroll] = useState(0);
  const previous = useRef<{ chat: ChatGuid; cursor: MessageGuid | null; offset: number; height: number; width: number; maximum: number } | null>(null);
  // Kept while the messages are, so each row's chips keep their identity and bubbles skip rendering.
  const rows = useMemo(() => foldTapbacks(props.messages), [props.messages]);
  const lastOwn = useMemo(() => lastOwnReceipt(props.messages), [props.messages]);
  const select = useStableCallback(props.onSelect);
  const viewAttachment = useStableCallback((attachment: Attachment) => props.onViewAttachment?.(attachment));
  const selected = props.cursor ?? props.messages.findLast(message => message.kind !== "tapback")?.guid ?? null;
  const viewportHeight = Math.max(1, props.height - 3 - (props.readError ? 1 : 0));
  const contentWidth = Math.max(1, props.width - 4);
  const maximum = () => Math.max(0, (content.current?.yogaNode?.getComputedHeight() ?? 0) - viewportHeight);
  useMouse(viewport, event => {
    if (event.kind !== "wheel" || !props.focused) return false;
    setScroll(value => Math.max(0, Math.min(maximum(), value + (event.direction === "up" ? -3 : 3))));
    return true;
  });
  useInput((_input, key) => {
    if (key.pageUp) setScroll(value => Math.max(0, value - Math.max(1, viewportHeight - 1)));
    if (key.pageDown) setScroll(value => Math.min(maximum(), value + Math.max(1, viewportHeight - 1)));
    if (key.home) setScroll(0);
    if (key.end) setScroll(maximum());
  }, { isActive: props.focused });
  useLayoutEffect(() => {
    const node = selected ? elements.current.get(selected)?.yogaNode : undefined;
    const top = node?.getComputedTop() ?? 0;
    const height = node?.getComputedHeight() ?? 0;
    const saved = previous.current;
    const bottom = maximum();
    setScroll(current => {
      if (!saved || saved.chat !== props.chatGuid) return bottom;
      if (saved.cursor !== selected || saved.width !== props.width) {
        if (height >= viewportHeight || top < current) return Math.min(bottom, top);
        if (top + height > current + viewportHeight) return Math.min(bottom, top + height - viewportHeight);
      }
      // Resting on the newest message, the view follows new messages and receipts.
      if (current >= saved.maximum) return bottom;
      if (saved.cursor === selected && saved.offset !== top) return Math.min(bottom, Math.max(0, current + top - saved.offset));
      return Math.min(bottom, current);
    });
    previous.current = { chat: props.chatGuid, cursor: selected, offset: top, height, width: props.width, maximum: bottom };
  }, [props.chatGuid, selected, props.messages, props.typing, props.width, props.height, viewportHeight]);
  const status = historyStatus(props.history);
  return <Box width={props.width} height={props.height} flexShrink={0} flexDirection="column">
    <Box height={3} paddingTop={1} flexShrink={0} paddingX={2} flexDirection="column">
      <Text bold color={colors.text} wrap="truncate-end">{props.title}</Text>
      <Text wrap="truncate-end"><Text color={props.subtitle.color}>{props.subtitle.text}</Text>{status ? <Text color={props.history.kind === "error" ? colors.failed : colors.subtle}>{`  ${status}`}</Text> : null}</Text>
    </Box>
    <Box ref={viewport} height={viewportHeight} flexShrink={0} overflow="hidden" flexDirection="column">
      <Box ref={content} position="absolute" top={-scroll} left={2} width={contentWidth} flexDirection="column" flexShrink={0}>
        {props.history.kind === "ready" && props.history.next ? <Box marginTop={1} justifyContent="center" flexShrink={0}><Text color={colors.subtle}>g for older messages</Text></Box> : null}
        {rows.map((row, index) => {
          if (row.kind === "day") return <DayRule key={row.key} label={row.label} width={contentWidth} />;
          const preceding = rows[index - 1];
          return <Box key={row.key} flexShrink={0} ref={element => { if (element) elements.current.set(row.message.guid, element); else elements.current.delete(row.message.guid); }}>
            <Bubble message={row.message} chips={row.chips} grouped={preceding?.kind === "message" && sameSender(preceding.message, row.message)} showReceipt={lastOwn?.guid === row.message.guid} selected={props.focused && selected === row.message.guid} tint={props.group && row.message.kind === "text" && !row.message.isFromMe ? personColor(row.message.from.address) : undefined} width={contentWidth} onSelect={select} onViewAttachment={viewAttachment} loadAttachment={props.loadAttachment} />
          </Box>;
        })}
        {props.history.kind === "ready" && !props.messages.length ? <Box marginTop={1} flexShrink={0}><Text color={colors.subtle}>No messages yet</Text></Box> : null}
        {props.typing ? <Box marginTop={1} flexShrink={0} borderStyle={bar("▎")} borderTop={false} borderRight={false} borderBottom={false} borderLeftColor={colors.faint} borderBackgroundColor={colors.canvas} paddingLeft={1}><Text color={colors.subtle}>• • •</Text></Box> : null}
      </Box>
    </Box>
    {props.readError ? <Box paddingX={2}><Text color={colors.warning} wrap="truncate-end">Read receipt not sent · m retries</Text></Box> : null}
  </Box>;
}

// A hairline across the lane with the day in the middle.
function DayRule(props: { label: string; width: number }) {
  const room = Math.max(0, props.width - props.label.length - 2);
  const left = Math.floor(room / 2);
  return <Box marginTop={1} flexShrink={0}>
    <Text wrap="truncate-end"><Text color={colors.rule}>{"─".repeat(left)} </Text><Text color={colors.subtle}>{props.label}</Text><Text color={colors.rule}> {"─".repeat(room - left)}</Text></Text>
  </Box>;
}

function historyStatus(history: HistoryState): string {
  if (history.kind === "loading") return history.mode === "older" ? "loading older…" : "loading…";
  if (history.kind === "error") return `couldn't load · Shift+R retries · ${history.message}`;
  if (history.kind === "unloaded") return "not loaded";
  return "";
}
