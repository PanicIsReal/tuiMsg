import { useMouse } from "./mouse.tsx";
import { useLayoutEffect, useRef, useState } from "react";
import { Box, Text, useInput, useBoxMetrics, type DOMElement } from "ink";
import type { Attachment, HistoryState, HttpUrl, LinkPreview, Message } from "../domain/model.ts";
import type { ChatGuid, MessageGuid } from "../domain/ids.ts";
import { foldTapbacks, lastOwnReceipt, sameSender } from "../domain/view.ts";
import { Bubble } from "./Bubble.tsx";
import { colors } from "./theme.ts";

export type TranscriptProps = {
  chatGuid: ChatGuid; title: string; messages: Message[]; typing: boolean;
  focused: boolean; interactive: boolean; cursor: MessageGuid | null; history: HistoryState;
  readError: string | null; width: number; height: number;
  onSelect: (messageGuid: MessageGuid) => void;
  onHistory: (mode: "latest" | "older") => void; onRetryRead: () => void;
  loadAttachment?: ((attachment: Attachment) => Promise<Uint8Array>) | undefined;
  loadLinkPreview?: ((url: HttpUrl) => Promise<LinkPreview>) | undefined;
  onViewAttachment?: ((attachment: Attachment) => void) | undefined;
  onOpenUrl?: ((url: HttpUrl) => void) | undefined;
};
export function Transcript(props: TranscriptProps) {
  const viewport = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const bottomButton = useRef<DOMElement>(null);
  const contentMetrics = useBoxMetrics(content);
  const bottomRequested = useRef(false);
  const elements = useRef(new Map<MessageGuid, DOMElement>());
  const [scroll, setScroll] = useState(0);
  const previous = useRef<{ chat: ChatGuid; cursor: MessageGuid | null; offset: number; height: number; width: number; maximum: number; lastGuid: MessageGuid | null; messageKeys: Set<MessageGuid> } | null>(null);
  const rows = foldTapbacks(props.messages);
  const lastOwn = lastOwnReceipt(props.messages);
  const latest = props.messages.findLast(message => message.kind !== "tapback")?.guid ?? null;
  const selected = props.cursor ?? latest;
  const selectedMessage = props.messages.find(message => message.guid === selected);
  const selectedKey = selectedMessage ? messageKey(selectedMessage) : selected;
  const latestMessage = props.messages.findLast(message => message.kind !== "tapback");
  const latestKey = latestMessage ? messageKey(latestMessage) : null;
  const viewportHeight = Math.max(1, props.height - 4 - (props.readError ? 1 : 0));
  const maximum = () => Math.max(0, (content.current?.yogaNode?.getComputedHeight() ?? 0) - viewportHeight);
  const scrollToBottom = () => {
    bottomRequested.current = latest !== selected;
    if (latest) props.onSelect(latest);
    setScroll(maximum());
  };
  useMouse(bottomButton, event => {
    if (!props.interactive || event.kind !== "click" || event.button !== "left") return false;
    scrollToBottom();
    return true;
  });
  useMouse(viewport, event => {
    if (event.kind !== "wheel" || !props.focused) return false;
    setScroll(value => Math.max(0, Math.min(maximum(), value + (event.direction === "up" ? -3 : 3))));
    return true;
  });
  useInput((input, key) => {
    if (key.pageUp) setScroll(value => Math.max(0, value - Math.max(1, viewportHeight - 1)));
    if (key.pageDown) setScroll(value => Math.min(maximum(), value + Math.max(1, viewportHeight - 1)));
    if (key.home) setScroll(0);
    if (key.end || (input === "d" && !key.ctrl && !key.meta)) scrollToBottom();
  }, { isActive: props.focused });
  useLayoutEffect(() => {
    const node = selected ? elements.current.get(selected)?.yogaNode : undefined;
    const top = node?.getComputedTop() ?? 0;
    const height = node?.getComputedHeight() ?? 0;
    const saved = previous.current;
    const requested = bottomRequested.current;
    bottomRequested.current = false;
    const newOwnSend = saved && selectedMessage?.kind === "text"
      && selectedMessage.isFromMe && selectedMessage.tempGuid
      && props.cursor === selected && saved.cursor !== selectedKey
      && !saved.messageKeys.has(selectedMessage.tempGuid);
    setScroll(current => {
      if (requested || newOwnSend) return maximum();
      if (!saved || saved.chat !== props.chatGuid) return maximum();
      if (saved.cursor === selectedKey && saved.lastGuid === latestKey && current >= saved.maximum) return maximum();
      if (saved.cursor !== selectedKey || saved.width !== props.width) {
        if (height >= viewportHeight || top < current) return Math.min(maximum(), top);
        if (top + height > current + viewportHeight) return Math.min(maximum(), top + height - viewportHeight);
      }
      if (saved.cursor === selectedKey && saved.offset !== top) return Math.min(maximum(), Math.max(0, current + top - saved.offset));
      return Math.min(maximum(), current);
    });
    previous.current = { chat: props.chatGuid, cursor: selectedKey, offset: top, height, width: props.width, maximum: maximum(), lastGuid: latestKey, messageKeys: new Set(props.messages.map(messageKey)) };
  }, [props.chatGuid, selected, props.messages, props.width, props.height, viewportHeight, contentMetrics.height]);
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
            <Bubble message={row.message} chips={row.chips} grouped={preceding?.kind === "message" && sameSender(preceding.message, row.message)} showReceipt={lastOwn?.guid === row.message.guid} selected={selected === row.message.guid} width={props.width - 4} onSelect={() => props.onSelect(row.message.guid)} onViewAttachment={props.onViewAttachment} onOpenUrl={props.onOpenUrl} loadAttachment={props.loadAttachment} loadLinkPreview={props.loadLinkPreview} />
          </Box>;
        })}
        {props.history.kind === "ready" && !props.messages.length ? <Text color={colors.secondary}> No messages yet</Text> : null}
        {props.typing ? <Text color={colors.secondary}> • • •</Text> : null}
      </Box>
    </Box>
    <Box height={1} paddingX={4}><Box flexShrink={1} overflow="hidden"><Text color={colors.subtle} wrap="truncate-end">{props.history.kind === "ready" && props.history.next ? "g older · " : ""}j/k select · r reply · t react · a files · v image</Text></Box><Box ref={bottomButton} flexShrink={0}><Text color={colors.subtle}> · d latest</Text></Box></Box>
    {props.readError ? <Text color={colors.failed} wrap="truncate-end">Read receipt failed · m retry</Text> : null}
  </Box>;
}
function historyLabel(history: HistoryState, count: number): string {
  if (history.kind === "loading") return history.mode === "older" ? `Loading older · ${count} shown` : "Loading messages…";
  if (history.kind === "error") return `History failed · R retry · ${history.message}`;
  if (history.kind === "unloaded") return "Messages not loaded";
  return `${count} message${count === 1 ? "" : "s"}`;
}

function messageKey(message: Message): MessageGuid {
  return message.kind === "text" ? message.tempGuid ?? message.guid : message.guid;
}
