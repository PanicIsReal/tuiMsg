import { useMouse } from "./mouse.tsx";
import { useLayoutEffect, useRef, useState } from "react";
import { Box, Text, useInput, type DOMElement } from "ink";
import type { Attachment, HistoryState, Message } from "../domain/model.ts";
import type { ChatGuid, MessageGuid } from "../domain/ids.ts";
import { foldTapbacks, lastOwnReceipt, sameSender } from "../domain/view.ts";
import { Bubble } from "./Bubble.tsx";
import { colors } from "./theme.ts";

export type TranscriptProps = {
  chatGuid: ChatGuid; title: string; messages: Message[]; typing: boolean;
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
  const rows = foldTapbacks(props.messages);
  const lastOwn = lastOwnReceipt(props.messages);
  const selected = props.cursor ?? props.messages.findLast(message => message.kind !== "tapback")?.guid ?? null;
  const viewportHeight = Math.max(1, props.height - 4 - (props.readError ? 1 : 0));
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
  return <Box width={props.width} height={props.height} flexShrink={0} flexDirection="column">
    <Box height={3} paddingTop={1} flexShrink={0} paddingX={4} flexDirection="column">
      <Text bold color={colors.text} wrap="truncate-end">{props.title}</Text>
      <Text color={props.history.kind === "error" ? colors.failed : colors.secondary} wrap="truncate-end">{historyLabel(props.history, props.messages.length)}</Text>
    </Box>
    <Box ref={viewport} height={viewportHeight} flexShrink={0} overflow="hidden" flexDirection="column">
      <Box ref={content} position="absolute" top={-scroll} left={2} width={props.width - 4} flexDirection="column" flexShrink={0}>
        {rows.map((row, index) => {
          if (row.kind === "day") return <Box key={row.key} paddingLeft={2} marginTop={1} flexShrink={0}><Text color={colors.secondary}>{row.label}</Text></Box>;
          const preceding = rows[index - 1];
          return <Box key={row.key} flexShrink={0} ref={element => { if (element) elements.current.set(row.message.guid, element); else elements.current.delete(row.message.guid); }}>
            <Bubble message={row.message} chips={row.chips} grouped={preceding?.kind === "message" && sameSender(preceding.message, row.message)} showReceipt={lastOwn?.guid === row.message.guid} selected={selected === row.message.guid} width={props.width - 4} onSelect={() => props.onSelect(row.message.guid)} onViewAttachment={props.onViewAttachment} loadAttachment={props.loadAttachment} />
          </Box>;
        })}
        {props.history.kind === "ready" && !props.messages.length ? <Text color={colors.secondary}> No messages yet</Text> : null}
        {props.typing ? <Text color={colors.secondary}> • • •</Text> : null}
      </Box>
    </Box>
    <Box height={1} paddingX={4}><Text color={colors.subtle} wrap="truncate-end">{props.history.kind === "ready" && props.history.next ? "g older · " : ""}j/k select · r reply · t react · a files · v image</Text></Box>
    {props.readError ? <Text color={colors.failed} wrap="truncate-end">Read receipt failed · m retry</Text> : null}
  </Box>;
}
function historyLabel(history: HistoryState, count: number): string {
  if (history.kind === "loading") return history.mode === "older" ? `Loading older · ${count} shown` : "Loading messages…";
  if (history.kind === "error") return `History failed · R retry · ${history.message}`;
  if (history.kind === "unloaded") return "Messages not loaded";
  return `${count} message${count === 1 ? "" : "s"}`;
}
