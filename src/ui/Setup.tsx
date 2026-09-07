import { Box, Text, useInput } from "ink";
import { useState, useSyncExternalStore } from "react";
import { TextInput } from "./TextInput.tsx";
import { colors } from "./theme.ts";

export type SetupState = {
  lines: string;
  prompt: { question: string; secret: boolean; submit(value: string): void } | null;
};

export type SetupView = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SetupState;
  cancel(): void;
};

export function SetupScreen({ view }: { view: SetupView }) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "d")) view.cancel();
  });
  return (
    <Box flexDirection="column" padding={1} backgroundColor={colors.canvas}>
      <Text color={colors.text}>{state.lines.trimEnd()}</Text>
      {state.prompt ? <SetupField key={state.prompt.question + state.lines.length} prompt={state.prompt} /> : null}
    </Box>
  );
}

function SetupField({ prompt }: { prompt: NonNullable<SetupState["prompt"]> }) {
  const [value, setValue] = useState("");
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent}>{prompt.question.trim()}</Text>
      <Box><Box width={2}><Text color={colors.text}>›</Text></Box><Box flexGrow={1}>
        <TextInput value={value} onChange={setValue} onSubmit={() => prompt.submit(value)} focused mask={prompt.secret ? "•" : undefined} />
      </Box></Box>
    </Box>
  );
}
