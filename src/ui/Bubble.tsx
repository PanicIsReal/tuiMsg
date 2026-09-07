import stringWidth from "string-width";
import { useMouse } from "./mouse.tsx";
import { Box, Text, type DOMElement } from "ink";
import { ImagePreview } from "./ImagePreview.tsx";
import { isImageAttachment } from "../attachments.ts";
import { memo, useRef } from "react";
import type { Attachment, Message, TapbackChip } from "../domain/model.ts";
import { colors, reactionGlyph } from "./theme.ts";

export type BubbleProps = {
  message: Exclude<Message, { kind: "tapback" }>;
  chips: TapbackChip[];
  showReceipt: boolean;
  grouped: boolean;
  selected: boolean;
  width: number;
  loadAttachment?: ((attachment: Attachment) => Promise<Uint8Array>) | undefined;
  onSelect: () => void;
  onViewAttachment?: ((attachment: Attachment) => void) | undefined;
};

export const Bubble = memo(function Bubble(props: BubbleProps) {
  const element = useRef<DOMElement>(null);
  useMouse(element, event => {
    if (event.kind !== "click" || event.button !== "left") return false;
    props.onSelect();
    return true;
  });
  const { message } = props;
  if (message.kind === "group-event" || message.kind === "unsent") {
    return (
      <Box ref={element} width="100%" paddingLeft={2} marginTop={1}>
        <Text><Text color={colors.secondary}>{props.selected ? "› " : ""}{message.kind === "unsent" ? "Unsent a message" : message.detail}</Text></Text>
      </Box>
    );
  }

  const mine = message.isFromMe;
  const body = normalizeBody(message.body);
  const imageAttachments = message.attachments.filter(isImageAttachment);
  const sender = mine ? "You" : message.from.contact?.displayName ?? message.from.address;
  const timestamp = `${formatMessageTime(message.sentAt)}${message.from.service === "SMS" ? " · SMS" : ""}`;
  const attachmentLabels = message.attachments.map(attachment => `${isImageAttachment(attachment) ? "↗" : "↓"} ${attachment.name}  ${formatBytes(attachment.bytes)}`);
  const reactions = props.chips.map(chip => `${reactionGlyph[chip.reaction]}${chip.count > 1 ? ` ×${chip.count}` : ""}`).join("  ");
  const naturalWidth = Math.max(
    stringWidth(`${sender}  ${timestamp}`),
    ...body.split("\n").map(line => stringWidth(line)),
    ...attachmentLabels.map(label => stringWidth(label)),
    stringWidth(reactions),
    props.showReceipt || ["pending", "failed", "uncertain"].includes(message.status) ? stringWidth(receiptLabel(message)) : 0,
    imageAttachments.length ? 48 : 1,
  );
  const contentWidth = Math.max(1, Math.min(naturalWidth, Math.floor((props.width - 4) * 0.7)));
  return <Box ref={element} width="100%" marginTop={props.grouped ? 0 : 1} flexDirection="row" flexShrink={0} paddingRight={2} justifyContent={mine ? "flex-end" : "flex-start"}>
    {!mine ? <Box width={2} flexShrink={0}><Text color={props.selected ? colors.focus : colors.subtle}>{props.selected ? "›" : " "}</Text></Box> : null}
    <Box width={contentWidth} flexDirection="column" flexShrink={0}>
      {!props.grouped ? <Box height={1} flexShrink={0}>
        <Text wrap="truncate-end"><Text bold={!mine} color={mine ? colors.secondary : colors.text}>{sender}</Text><Text color={colors.subtle}>  {timestamp}</Text></Text>
      </Box> : null}
      {body ? <Text color={colors.text}>{body}</Text> : null}
      {props.loadAttachment ? imageAttachments.map(attachment => <ImagePreview key={attachment.guid} attachment={attachment} loadAttachment={props.loadAttachment!} width={Math.min(48, contentWidth)} height={props.width < 60 ? 6 : 10} delayMs={150} />) : null}
      {message.attachments.map((attachment, index) => <AttachmentLink key={attachment.guid} label={attachmentLabels[index] ?? attachment.name} onOpen={() => props.onViewAttachment?.(attachment)} />)}
      {!body && !message.attachments.length ? <Text color={colors.subtle}>Empty message</Text> : null}
      {props.chips.length ? <Text color={colors.secondary}>{reactions}</Text> : null}
      {props.showReceipt || message.status === "pending" || message.status === "failed" || message.status === "uncertain" ? <Receipt message={message} /> : null}
    </Box>
    {mine ? <Box width={2} flexShrink={0}><Text color={props.selected ? colors.focus : colors.subtle}>{props.selected ? " ‹" : "  "}</Text></Box> : null}
  </Box>;
});

function Receipt(props: { message: Extract<Message, { kind: "text" }> }) {
  const { message } = props;
  const label = receiptLabel(message);
  if (!label) return null;
  return <Text><Text color={message.status === "failed" || message.status === "uncertain" ? colors.warning : colors.subtle}>{label}</Text></Text>;
}

function receiptLabel(message: Extract<Message, { kind: "text" }>): string {
  if (message.status === "pending") return "Sending";
  if (message.status === "failed") return "Not delivered  ·  ! retry";
  if (message.status === "uncertain") return "Delivery uncertain  ·  ! retry";
  if (message.status === "read" && message.readAt) return `Read ${formatMessageTime(message.readAt)}`;
  if (message.status === "delivered") return "Delivered";
  return "";
}

function normalizeBody(body: string): string {
  const lines = body.split("\n").flatMap((line) => {
    const normalized = line.replace(/\uFFFC/g, "");
    return normalized.trim().length === 0 && line.includes("\uFFFC") ? [] : [normalized];
  });
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function formatMessageTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentLink(props: { label: string; onOpen: () => void }) {
  const element = useRef<DOMElement>(null);
  useMouse(element, event => {
    if (event.kind !== "click" || event.button !== "left") return false;
    props.onOpen();
    return true;
  });
  return <Box ref={element}><Text color={colors.accent}>{props.label}</Text></Box>;
}
