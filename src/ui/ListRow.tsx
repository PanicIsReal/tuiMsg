import { memo } from "react";
import { colors } from "./theme.ts";

export type ListRowProps = {
  title: string
  preview: string
  time: string
  unread: boolean
  selected: boolean
  sms: boolean
};

export const ListRow = memo(function ListRow(props: ListRowProps) {
  const bg = props.selected ? colors.listSelected : colors.listBg;
  return (
    <box
      height={3}
      width="100%"
      backgroundColor={bg}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <box flexDirection="row" justifyContent="space-between">
        <text>
          {props.unread ? (
            <strong fg={colors.unread}>
              ●{" "}
            </strong>
          ) : null}
          {props.unread ? (
            <strong fg={colors.text}>{props.title}</strong>
          ) : (
            <span fg={colors.text}>{props.title}</span>
          )}
        </text>
        <text>
          <span fg={colors.secondary}>{props.time}</span>
        </text>
      </box>
      <text>
        <span fg={props.sms ? colors.outgoingSms : colors.secondary}>{props.preview}</span>
      </text>
    </box>
  );
});
