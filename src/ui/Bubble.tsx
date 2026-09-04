import { memo } from "react";
import type { Message, TapbackChip } from "../domain/model.ts";
import { colors, glyph, outgoingColor } from "./theme.ts";

export type BubbleProps = {
  message: Exclude<Message, { kind: "tapback" }>
  chips: TapbackChip[]
  showReceipt: boolean
  grouped: boolean
};

const EMPTY_CHIPS: TapbackChip[] = [];

export const Bubble = memo(function Bubble(props: BubbleProps) {
  const { message } = props;
  if (message.kind === "group-event" || message.kind === "unsent") {
    return (
      <box width="100%" justifyContent="center" marginTop={1}>
        <text>
          <span fg={colors.secondary}>
            {message.kind === "unsent" ? "Unsent a message" : message.detail}
          </span>
        </text>
      </box>
    );
  }

  const mine = message.isFromMe;
  const service = message.from.service;
  const bg = mine ? outgoingColor(service) : colors.incoming;
  const fg = mine ? colors.textOnBubble : colors.text;
  const body =
    message.kind === "attachment" ? `[${message.name} ${formatBytes(message.bytes)}]` : message.body;
  const chips = props.chips.length > 0 ? props.chips : EMPTY_CHIPS;

  return (
    <box
      width="100%"
      justifyContent={mine ? "flex-end" : "flex-start"}
      marginTop={props.grouped ? 0 : 1}
      paddingLeft={mine ? 8 : 1}
      paddingRight={mine ? 1 : 8}
    >
      <box
        backgroundColor={bg}
        border
        borderStyle="rounded"
        borderColor={bg}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
      >
        {mine ? null : (
          <text>
            <span fg={colors.secondary}>{message.from.contact?.displayName ?? message.from.address}</span>
          </text>
        )}
        <text>
          <span fg={fg}>{body}</span>
        </text>
        {chips.length > 0 ? (
          <text>
            {chips.map((chip) => (
              <span key={chip.reaction} fg={colors.text}>
                {glyph[chip.reaction]}
                {chip.count > 1 ? `×${chip.count}` : ""}{" "}
              </span>
            ))}
          </text>
        ) : null}
        {props.showReceipt && message.kind === "text" ? (
          <text>
            <span fg={colors.secondary}>{receiptLabel(message)}</span>
          </text>
        ) : null}
      </box>
    </box>
  );
});

function receiptLabel(message: Extract<Message, { kind: "text" }>): string {
  if (message.status === "pending") return "Sending";
  if (message.status === "failed") return "Not Delivered";
  if (message.status === "read" && message.readAt) {
    return `Read ${new Date(message.readAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  if (message.status === "delivered") return "Delivered";
  return "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
