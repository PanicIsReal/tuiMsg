import { useCallback, useMemo, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import type { AppEvent, AppState, Chat } from "../domain/model.ts";
import { sortedChats } from "../domain/view.ts";
import { List } from "./List.tsx";
import { Transcript } from "./Transcript.tsx";
import { Composer } from "./Composer.tsx";
import { Help } from "./Help.tsx";
import { colors } from "./theme.ts";

export type AppProps = {
  state: AppState
  dispatch: (event: AppEvent) => void
  onSend: (chat: Chat, text: string) => void
  onYank: (text: string) => void
};

export function App(props: AppProps) {
  const { state, dispatch } = props;
  const selectedRef = useRef(state.selected);
  selectedRef.current = state.selected;

  const chats = useMemo(
    () => sortedChats(state.chats, state.search),
    [state.chats, state.search],
  );
  const selected = state.selected ? state.chats.get(state.selected) : undefined;
  const messages = state.selected ? (state.messages.get(state.selected) ?? []) : [];
  const typing = state.selected ? Boolean(state.typing.get(state.selected)) : false;

  const moveList = useCallback(
    (delta: number) => {
      if (chats.length === 0) return;
      const index = Math.max(
        0,
        chats.findIndex((c) => c.guid === state.selected),
      );
      const next = chats[Math.min(chats.length - 1, Math.max(0, index + delta))];
      if (next) dispatch({ type: "select-chat", chatGuid: next.guid });
    },
    [chats, dispatch, state.selected],
  );

  useKeyboard((key) => {
    if (key.name === "q" && state.overlay !== "none" && state.focus !== "composer") {
      dispatch({ type: "overlay", overlay: "none" });
      return;
    }
    if (state.overlay === "help" && key.name === "escape") {
      dispatch({ type: "overlay", overlay: "none" });
      return;
    }
    if (key.sequence === "?" || (key.shift && key.name === "/")) {
      dispatch({ type: "overlay", overlay: state.overlay === "help" ? "none" : "help" });
      return;
    }
    if (key.name === "escape") {
      if (state.overlay !== "none") {
        dispatch({ type: "overlay", overlay: "none" });
        return;
      }
      if (state.focus === "composer") {
        dispatch({ type: "focus", focus: "transcript" });
        return;
      }
      dispatch({ type: "focus", focus: "list" });
      return;
    }
    if (key.name === "tab") {
      const order = ["list", "transcript", "composer"] as const;
      const i = order.indexOf(state.focus);
      const next = order[(i + (key.shift ? order.length - 1 : 1)) % order.length];
      if (next) dispatch({ type: "focus", focus: next });
      return;
    }
    if (key.name === "/" && state.focus !== "composer") {
      dispatch({ type: "overlay", overlay: "search" });
      dispatch({ type: "focus", focus: "list" });
      return;
    }
    if (key.name === "i" && state.focus !== "composer") {
      dispatch({ type: "focus", focus: "composer" });
      return;
    }
    if (state.focus === "list") {
      if (key.name === "j" || key.name === "down") moveList(1);
      if (key.name === "k" || key.name === "up") moveList(-1);
      if (key.name === "return" && chats[0] && !state.selected) {
        dispatch({ type: "select-chat", chatGuid: chats[0].guid });
      }
    }
    if (key.name === "y" && state.focus === "transcript") {
      const last = [...messages].reverse().find((m) => m.kind === "text");
      if (last && last.kind === "text") props.onYank(last.body);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.canvas}>
      <box flexDirection="row" flexGrow={1}>
        <List
          chats={chats}
          selected={state.selected}
          search={state.search}
          searchFocused={state.overlay === "search"}
        />
        <box flexGrow={1} flexDirection="column" backgroundColor={colors.canvas}>
          {selected ? (
            <Transcript title={selected.title} messages={messages} typing={typing} />
          ) : (
            <box flexGrow={1} justifyContent="center" alignItems="center">
              <text>
                <span fg={colors.secondary}>Select a conversation</span>
              </text>
            </box>
          )}
          <Composer
            value={state.composer}
            protocol={selected?.service ?? "iMessage"}
            focused={state.focus === "composer"}
            onChange={(text) => dispatch({ type: "composer-set", text })}
            onSubmit={() => {
              if (!selected || state.composer.trim().length === 0) return;
              props.onSend(selected, state.composer);
            }}
          />
        </box>
      </box>
      <box height={1} paddingLeft={1} backgroundColor={colors.listBg}>
        <text>
          <span fg={colors.secondary}>
            {state.connection}
            {state.capabilities.helperConnected ? "  private-api" : ""}
            {"   ? help"}
            {state.copiedAt ? "   Copied" : ""}
          </span>
        </text>
      </box>
      {state.overlay === "help" ? (
        <box position="absolute" left={8} top={4}>
          <Help />
        </box>
      ) : null}
    </box>
  );
}
