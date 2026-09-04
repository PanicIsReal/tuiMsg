import { memo, useEffect, useRef } from "react";
import type { TextareaRenderable } from "@opentui/core";
import { colors } from "./theme.ts";

export let composerMounts = 0;

export type ComposerProps = {
  value: string
  protocol: "iMessage" | "SMS"
  focused: boolean
  onChange: (text: string) => void
  onSubmit: () => void
};

export const Composer = memo(function Composer(props: ComposerProps) {
  const ref = useRef<TextareaRenderable>(null);
  useEffect(() => {
    composerMounts += 1;
  }, []);

  return (
    <box
      height={4}
      width="100%"
      backgroundColor={colors.composer}
      border
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <text>
        <span fg={props.protocol === "SMS" ? colors.outgoingSms : colors.outgoingIMessage}>
          {props.protocol} ›
        </span>
      </text>
      <textarea
        ref={ref}
        focused={props.focused}
        initialValue={props.value}
        placeholder="iMessage"
        flexGrow={1}
        onContentChange={() => {
          props.onChange(ref.current?.plainText ?? "");
        }}
        onSubmit={() => {
          props.onSubmit();
          ref.current?.setText("");
        }}
      />
    </box>
  );
});
