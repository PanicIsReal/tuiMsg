import type { Message } from "../domain/model.ts";
import { foldTapbacks, lastOwnReceipt, sameSender } from "../domain/view.ts";
import { Bubble } from "./Bubble.tsx";
import { colors } from "./theme.ts";

export type TranscriptProps = {
  title: string
  messages: Message[]
  typing: boolean
};

export function Transcript(props: TranscriptProps) {
  const rows = foldTapbacks(props.messages);
  const lastOwn = lastOwnReceipt(props.messages);
  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={colors.canvas}>
      <box height={2} paddingLeft={1} borderColor={colors.border} border>
        <text>
          <strong fg={colors.text}>
            {props.title}
          </strong>
        </text>
      </box>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" viewportCulling>
        {rows.map((row, index) => {
          if (row.kind === "day") {
            return (
              <box key={row.key} width="100%" justifyContent="center" marginTop={1}>
                <text>
                  <span fg={colors.secondary}>{row.label}</span>
                </text>
              </box>
            );
          }
          const prev = rows[index - 1];
          const grouped =
            prev?.kind === "message" &&
            sameSender(prev.message, row.message);
          return (
            <Bubble
              key={row.key}
              message={row.message}
              chips={row.chips}
              grouped={grouped}
              showReceipt={lastOwn?.guid === row.message.guid}
            />
          );
        })}
        {props.typing ? (
          <box marginTop={1} paddingLeft={1}>
            <box backgroundColor={colors.incoming} border borderStyle="rounded" paddingLeft={1} paddingRight={1}>
              <text>
                <span fg={colors.secondary}>• • •</span>
              </text>
            </box>
          </box>
        ) : null}
      </scrollbox>
    </box>
  );
}
