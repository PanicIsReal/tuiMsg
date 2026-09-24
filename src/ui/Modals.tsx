import { Children } from "react";
import { TextInput } from "./TextInput.tsx";
import { Box, Text, useWindowSize } from "ink";
import type { Attachment, InputMode, Reaction } from "../domain/model.ts";
import { colors, reactionGlyph } from "./theme.ts";

export function SearchModal(props: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  return (
    <Modal width={48}>
      <Text><Text bold color={colors.text}>Search conversations</Text></Text>
      <TextInput focused value={props.value} placeholder="Name or message" onChange={props.onChange} onSubmit={props.onClose} />
      <Text><Text color={colors.secondary}>Enter or Esc keeps results</Text></Text>
    </Modal>
  );
}

export function NewChatModal(props: {
  mode: Extract<InputMode, { kind: "new-chat" }>;
  bridge: boolean;
  onChange: (mode: Extract<InputMode, { kind: "new-chat" }>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const compact = useWindowSize().rows < 18;
  const set = (patch: Partial<Extract<InputMode, { kind: "new-chat" }>>) => props.onChange({ ...props.mode, ...patch });
  return (
    <Modal width={58}>
      <Text><Text bold color={colors.text}>New conversation</Text></Text>
      <Text><Text color={props.mode.field === "addresses" ? colors.accent : colors.secondary}>Recipients</Text></Text>
      <TextInput focused={props.mode.field === "addresses" && !props.mode.busy} value={props.mode.addresses} placeholder="+1 555…, friend@example.com"
        onChange={(addresses) => set({ addresses })} onSubmit={() => set({ field: "text" })} rows={1} />
      <Text color={colors.secondary}>First message</Text>
      <TextInput focused={props.mode.field === "text" && !props.mode.busy} value={props.mode.text} placeholder="Write the first message"
        onChange={(text) => set({ text })} onSubmit={props.onSubmit} multiline rows={compact ? 1 : 2} />
      <Box flexDirection="row">
        <Text><Text color={props.mode.service === "iMessage" ? colors.outgoingIMessage : colors.secondary}> iMessage </Text></Text>
        <Text><Text color={props.mode.service === "SMS" ? colors.outgoingSms : colors.secondary}> SMS </Text></Text>
      </Box>
      {props.mode.error ? <Text><Text color={colors.failed}>{props.mode.error}</Text></Text> : null}
      {!props.bridge && !compact ? <Text><Text color={colors.warning}>Group conversations need the imsg bridge.</Text></Text> : null}
      <Text><Text color={colors.secondary}>{props.mode.busy ? "Creating…" : compact ? "Tab field · Ctrl+S send" : "Tab field · Ctrl+S send · Ctrl+T service"}</Text></Text>
      <Text><Text color={colors.secondary}>{compact ? "Ctrl+T service · Esc cancel" : "Esc cancel"}</Text></Text>
    </Modal>
  );
}

export function ReactionModal(props: { choice: number }) {
  const reactions = Object.entries(reactionGlyph) as [Reaction, string][];
  return (
    <Modal width={48}>
      <Text><Text bold color={colors.text}>React to message</Text></Text>
      <Box flexDirection="row" flexWrap="wrap">{reactions.map(([reaction, glyph], index) => <Text key={reaction}><Text color={index === props.choice ? colors.accent : colors.text}> {index + 1} {glyph} </Text></Text>)}</Box>
      <Text><Text color={colors.secondary}>←/→ choose · Enter add · x remove · Esc cancel</Text></Text>
    </Modal>
  );
}

export function AttachmentModal(props: { attachments: Attachment[]; choice: number }) {
  const { rows } = useWindowSize();
  const count = Math.max(1, rows - 8);
  const start = Math.max(0, Math.min(props.choice - Math.floor(count / 2), props.attachments.length - count));
  return (
    <Modal width={58}>
      <Text><Text bold color={colors.text}>Attachments</Text></Text>
      {props.attachments.slice(start, start + count).map((attachment, offset) => (
        <Text key={attachment.guid} wrap="truncate-end"><Text color={offset + start === props.choice ? colors.accent : colors.text}>{offset + start === props.choice ? "› " : "  "}{attachment.name} · {attachment.mime}</Text></Text>
      ))}
      <Text><Text color={colors.secondary}>j/k choose · v preview · o open · s save · Esc cancel</Text></Text>
    </Modal>
  );
}

export function ConfirmModal() {
  return (
    <Modal width={54}>
      <Text><Text bold color={colors.warning}>Retry this message?</Text></Text>
      <Text><Text color={colors.text}>The first attempt may have reached the recipient.</Text></Text>
      <Text><Text color={colors.secondary}>y retry · n or Esc cancel</Text></Text>
    </Modal>
  );
}

function Modal(props: { width: number; children: React.ReactNode }) {
  const { rows } = useWindowSize();
  return (
    <Box width={props.width} maxWidth="92%" maxHeight="100%" borderStyle="round" borderBackgroundColor={colors.canvas}
      borderColor={colors.accent} backgroundColor={colors.panelRaised} paddingX={1} paddingY={rows < 18 ? 0 : 1} flexDirection="column" overflow="hidden">
      {Children.map(props.children, child => child ? <Box flexDirection="column" flexShrink={0}>{child}</Box> : null)}
    </Box>
  );
}
