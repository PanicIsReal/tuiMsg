import { memo } from "react";
import { Box, Text } from "ink";
import type { Draft, Service } from "../domain/model.ts";
import { inputRowCount, TextInput } from "./TextInput.tsx";
import { colors, useTheme } from "./theme.ts";

export type ComposerProps = {
  draft: Draft; service: Service; focused: boolean;
  // The lane's width, and the most rows the input may grow to before it scrolls.
  width: number; maxRows: number;
  // Who and what a reply answers, shown above the input.
  replyingTo?: string | undefined;
  onChange: (text: string) => void; onSubmit: () => void; onEscape: () => void;
};
// The input's own width: the lane less its padding and the prompt.
const inputWidth = (width: number) => Math.max(1, width - 6);

// While writing, the box grows with the draft as it wraps, not just at new lines.
export function composerHeight(draft: Draft, focused: boolean, width: number, maxRows: number): number {
  const reply = draft.replyTo ? 1 : 0;
  return focused ? 1 + reply + Math.min(maxRows, Math.max(1, inputRowCount(draft.text, inputWidth(width)))) : 2 + reply;
}
// A hairline, then the input with the service as its placeholder, like the Messages field.
export const Composer = memo(function Composer(props: ComposerProps) {
  useTheme();
  const height = composerHeight(props.draft, props.focused, props.width, props.maxRows);
  const placeholder = props.service === "SMS" ? "Text Message" : "iMessage";
  const prompt = props.focused ? colors.accent : colors.subtle;
  return <Box height={height} flexShrink={0} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor={colors.rule} borderBackgroundColor={colors.canvas} paddingX={2} flexDirection="column">
    {props.draft.replyTo ? <Text wrap="truncate-end"><Text color={colors.accent}>↩ </Text><Text color={colors.secondary}>{props.replyingTo ?? "Replying"}</Text></Text> : null}
    {props.focused
      ? <Box height={height - 1 - (props.draft.replyTo ? 1 : 0)} overflow="hidden"><Box width={2} flexShrink={0}><Text color={prompt}>›</Text></Box><Box flexGrow={1}><TextInput value={props.draft.text} focused onChange={props.onChange} onSubmit={props.onSubmit} placeholder={placeholder} multiline rows={height - 1 - (props.draft.replyTo ? 1 : 0)} width={inputWidth(props.width)} /></Box></Box>
      : <Text wrap="truncate-end"><Text color={prompt}>› </Text>{props.draft.text ? <Text color={colors.secondary}>{props.draft.text.replace(/\s*\n\s*/g, " ")}</Text> : <Text color={props.service === "SMS" ? colors.sms : colors.subtle}>{placeholder}</Text>}</Text>}
  </Box>;
});
