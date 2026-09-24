import { useMouse } from "./mouse.tsx";
import { Box, Text, Transform, type DOMElement } from "ink";
import { ImagePreview } from "./ImagePreview.tsx";
import { isImageAttachment } from "../attachments.ts";
import { memo, useRef } from "react";
import { appMessageLabel, type Attachment, type Message, type TapbackChip } from "../domain/model.ts";
import { bar, colors, reactionGlyph, useTheme } from "./theme.ts";
import { cleanText } from "../domain/text.ts";
import { hyperlink, linkParts } from "../domain/links.ts";

export type BubbleProps = {
  message: Exclude<Message, { kind: "tapback" }>;
  chips: TapbackChip[];
  showReceipt: boolean;
  grouped: boolean;
  selected: boolean;
  // A group member's own color for their name and bar.
  tint?: string | undefined;
  width: number;
  loadAttachment?: ((attachment: Attachment) => Promise<Uint8Array>) | undefined;
  onSelect: () => void;
  onViewAttachment?: ((attachment: Attachment) => void) | undefined;
};

// Every message hangs off a bar down its left side: blue for yours, gray for theirs, so a run
// of messages from one person reads as one block. The selected message's bar is solid.
const MESSAGE_BAR = bar("▎");
const SELECTED_BAR = bar("▌");

export const Bubble = memo(function Bubble(props: BubbleProps) {
  useTheme();
  const element = useRef<DOMElement>(null);
  useMouse(element, event => {
    if (event.kind !== "click" || event.button !== "left") return false;
    props.onSelect();
    return true;
  });
  const { message } = props;
  if (message.kind === "group-event" || message.kind === "unsent") {
    return (
      <Box ref={element} width="100%" marginTop={1} justifyContent="center">
        <Text wrap="truncate-end" color={props.selected ? colors.text : colors.subtle}>{message.kind === "unsent" ? "Unsent a message" : message.detail}</Text>
      </Box>
    );
  }

  const mine = message.isFromMe;
  const body = normalizeBody(message.body);
  const imageAttachments = message.attachments.filter(isImageAttachment);
  const contentWidth = Math.max(1, props.width - 2);
  const sender = mine ? "You" : message.from.contact?.displayName ?? message.from.address;
  const receipt = props.showReceipt || message.status === "pending" || message.status === "failed" || message.status === "uncertain" ? receiptLabel(message) : "";
  const app = appMessageLabel(message.balloon);
  return <Box ref={element} width="100%" marginTop={props.grouped ? 0 : 1} flexDirection="column" flexShrink={0}>
    <Box borderStyle={props.selected ? SELECTED_BAR : MESSAGE_BAR} borderTop={false} borderRight={false} borderBottom={false}
      borderLeftColor={props.selected ? colors.text : mine ? colors.accent : props.tint ?? colors.faint} borderBackgroundColor={colors.canvas} paddingLeft={1} flexDirection="column" flexShrink={0}>
      {!props.grouped ? <Box height={1} flexShrink={0}>
        <Text wrap="truncate-end"><Text bold color={mine ? colors.accent : props.tint ?? colors.text}>{sender}</Text><Text color={colors.subtle}>  {formatMessageTime(message.sentAt)}</Text>{message.from.service === "SMS" ? <Text color={colors.sms}>  SMS</Text> : null}</Text>
      </Box> : null}
      <Box flexDirection="row" flexShrink={0}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {body ? <Body text={body} /> : null}
          {props.loadAttachment ? imageAttachments.map(attachment => <ImagePreview key={attachment.guid} attachment={attachment} loadAttachment={props.loadAttachment!} width={Math.min(48, contentWidth)} height={props.width < 60 ? 6 : 10} delayMs={150} />) : null}
          {message.attachments.map(attachment => <AttachmentLink key={attachment.guid} image={isImageAttachment(attachment)} name={attachment.name} size={formatBytes(attachment.bytes)} onOpen={() => props.onViewAttachment?.(attachment)} />)}
          {!body && !message.attachments.length ? <Text color={colors.subtle}>{app ? `${app} · shown only in Messages` : "Empty message"}</Text> : null}
        </Box>
        {/* Reactions hang off the message's top right, as a tapback does in Messages. */}
        {props.chips.length ? <Box flexShrink={0} marginLeft={2}><Text>{props.chips.map((chip, index) => <Text key={`${chip.reaction}${chip.emoji ?? ""}`} color={chip.fromMe ? colors.accent : colors.secondary}>{index ? "  " : ""}{chip.reaction === "emoji" ? chip.emoji ?? "?" : reactionGlyph[chip.reaction]}{chip.count > 1 ? ` ${chip.count}` : ""}</Text>)}</Text></Box> : null}
      </Box>
    </Box>
    {receipt ? <Box paddingLeft={2} flexShrink={0}><Text wrap="truncate-end" color={message.status === "failed" || message.status === "uncertain" ? colors.warning : colors.subtle}>{receipt}</Text></Box> : null}
  </Box>;
});

// Ink wraps with whitespace kept, so a word that ends exactly at the edge pushes the space
// after it to the start of the next line. Only wrapped lines lose it; each typed line is
// its own Text, so indentation after a real newline stays.
const dropWrapSpace = (line: string, index: number) => index === 0 ? line : line.replace(/^((?:\x1b\[[\d;]*m)*) /, "$1");

// Links stand out from the words around them, as they do in Messages.
function Body(props: { text: string }) {
  return <Box flexDirection="column">
    {props.text.split("\n").map((line, row) => <Transform key={row} transform={dropWrapSpace}>
      <Text color={colors.text}>{line ? linkParts(line).map((part, index) => part.url ? <Text key={index} color={colors.accent} underline>{hyperlink(part.url, part.text)}</Text> : part.text) : " "}</Text>
    </Transform>)}
  </Box>;
}

function receiptLabel(message: Extract<Message, { kind: "text" }>): string {
  if (message.status === "pending") return "Sending";
  if (message.status === "failed") return "Not delivered · ! to retry";
  if (message.status === "uncertain") return "Delivery uncertain · ! to retry";
  if (message.status === "read" && message.readAt) return `Read ${formatMessageTime(message.readAt)}`;
  if (message.status === "delivered") return "Delivered";
  return "";
}

function normalizeBody(body: string): string {
  // Received text is cleaned when parsed; a pending bubble shows the local draft as typed.
  const lines = cleanText(body).split("\n").flatMap((line) => {
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

function AttachmentLink(props: { image: boolean; name: string; size: string; onOpen: () => void }) {
  const element = useRef<DOMElement>(null);
  useMouse(element, event => {
    if (event.kind !== "click" || event.button !== "left") return false;
    props.onOpen();
    return true;
  });
  return <Box ref={element}><Text wrap="truncate-end"><Text color={colors.accent}>{props.image ? "↗" : "↓"} </Text><Text color={colors.secondary}>{props.name}</Text><Text color={colors.subtle}>  {props.size}</Text></Text></Box>;
}
