import { memo } from "react";
import { Box, Text } from "ink";
import type { Draft, Service } from "../domain/model.ts";
import { TextInput } from "./TextInput.tsx";
import { colors } from "./theme.ts";

export type ComposerProps = {
  draft: Draft; service: Service; focused: boolean;
  onChange: (text: string) => void; onSubmit: () => void; onEscape: () => void;
};
export function composerHeight(draft: Draft, focused: boolean): number {
  return focused ? Math.min(7, Math.max(4, 3 + draft.text.split("\n").length)) : 3;
}
export const Composer = memo(function Composer(props: ComposerProps) {
  const height = composerHeight(props.draft, props.focused);
  return <Box height={height} flexShrink={0} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor={colors.border} borderBackgroundColor={colors.canvas} paddingX={2} flexDirection="column">
    <Text wrap="truncate-end"><Text color={props.service === "SMS" ? colors.sms : colors.accent}>{props.service}</Text><Text color={colors.secondary}>{props.focused ? props.draft.replyTo ? "  Replying · Enter send" : "  Enter send · Ctrl+J newline" : props.draft.text ? "  Draft saved · i to edit" : "  i to compose"}</Text></Text>
    {props.focused ? <Box height={height - 3} overflow="hidden"><Box width={2} flexShrink={0}><Text color={colors.text}>›</Text></Box><Box flexGrow={1}><TextInput value={props.draft.text} focused onChange={props.onChange} onSubmit={props.onSubmit} placeholder="Write a message" multiline rows={height - 3} /></Box></Box> : null}
  </Box>;
});
