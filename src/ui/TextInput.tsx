import { isMouseSequence } from "./mouse.tsx";
import stringWidth from "string-width";
import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useBoxMetrics, type DOMElement } from "ink";
import { colors } from "./theme.ts";

export function TextInput(props: {
  value: string; onChange: (value: string) => void; onSubmit: () => void;
  focused: boolean; placeholder?: string; multiline?: boolean; rows?: number; mask?: string | undefined;
}) {
  const box = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(box);
  const [position, setPosition] = useState(Array.from(props.value).length);
  const editing = useRef({ value: props.value, cursor: position });
  useEffect(() => { editing.current = { value: props.value, cursor: Math.min(editing.current.cursor, Array.from(props.value).length) }; }, [props.value]);
  const characters = Array.from(props.value);
  const cursor = Math.min(position, characters.length);
  useEffect(() => { if (!props.value) setPosition(0); }, [props.value]);
  usePaste(text => {
    const characters = Array.from(editing.current.value);
    const cursor = editing.current.cursor;
    const value = text.replace(/\r\n?/g, "\n").replace(props.multiline ? /\x00/g : /[\n\x00]/g, "");
    const next = [...characters.slice(0, cursor), value, ...characters.slice(cursor)].join("");
    editing.current = { value: next, cursor: cursor + Array.from(value).length };
    props.onChange(next);
    setPosition(editing.current.cursor);
  }, { isActive: props.focused });
  useInput((input, key) => {
    const characters = Array.from(editing.current.value);
    const cursor = editing.current.cursor;
    const move = (next: number) => { editing.current.cursor = next; setPosition(next); };
    if (isMouseSequence(input) || key.escape || key.tab || (key.ctrl && !["a", "e", "j", "u", "w"].includes(input))) return;
    const edit = (start: number, end: number, text: string) => {
      const next = [...characters.slice(0, start), text, ...characters.slice(end)].join("");
      editing.current = { value: next, cursor: start + Array.from(text).length };
      props.onChange(next);
      setPosition(editing.current.cursor);
    };
    if (key.leftArrow) { move(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { move(Math.min(characters.length, cursor + 1)); return; }
    if (key.home || key.ctrl && input === "a") { move(0); return; }
    if (key.end || key.ctrl && input === "e") { move(characters.length); return; }
    if (key.ctrl && input === "u") { edit(0, cursor, ""); return; }
    if (key.ctrl && input === "w") {
      const before = characters.slice(0, cursor).join("");
      edit(Array.from(before.replace(/\s*\S+\s*$/, "")).length, cursor, ""); return;
    }
    if (key.backspace) { if (cursor) edit(cursor - 1, cursor, ""); return; }
    if (key.delete) { edit(cursor, Math.min(characters.length, cursor + 1), ""); return; }
    if (key.upArrow || key.downArrow) {
      const before = characters.slice(0, cursor).join("");
      const lines = editing.current.value.split("\n");
      const row = before.split("\n").length - 1;
      const column = Array.from(before.split("\n").at(-1) ?? "").length;
      const next = Math.max(0, Math.min(lines.length - 1, row + (key.upArrow ? -1 : 1)));
      move(lines.slice(0, next).reduce((sum, line) => sum + Array.from(line).length + 1, 0) + Math.min(column, Array.from(lines[next] ?? "").length));
      return;
    }
    if (key.return || key.ctrl && input === "j" || input === "\n") {
      if (props.multiline && (key.shift || key.meta || key.ctrl || input === "\n")) edit(cursor, cursor, "\n");
      else props.onSubmit();
      return;
    }
    if (input && !key.meta && !key.ctrl) edit(cursor, cursor, input.replace(/\r\n?/g, "\n").replace(props.multiline ? /\x00/g : /[\n\x00]/g, ""));
  }, { isActive: props.focused });
  const visible = props.mask ? characters.map(() => props.mask ?? "*") : characters;
  const lines: { text: string; index: number }[][] = [[]];
  let column = 0;
  let cursorRow = 0;
  for (let index = 0; index <= visible.length; index++) {
    const character = visible[index] ?? " ";
    const width = character === "\n" ? 1 : stringWidth(character);
    if (column + width > Math.max(1, metrics.width)) { lines.push([]); column = 0; }
    if (index === cursor) cursorRow = lines.length - 1;
    if (character !== "\n" || index === cursor) lines.at(-1)!.push({ text: character === "\n" ? " " : character, index });
    if (character === "\n") { lines.push([]); column = 0; }
    else column += width;
  }
  const rowCount = props.rows ?? 4;
  const start = Math.max(0, cursorRow - rowCount + 1);
  return <Box ref={box} width="100%" flexDirection="column">
    {lines.slice(start, start + rowCount).map((line, row) => <Text key={start + row} color={colors.text}>
      {line.map(cell => <Text key={cell.index} inverse={props.focused && cell.index === cursor}>{cell.text}</Text>)}
      {!props.value && row === 0 ? <Text color={colors.subtle}>{props.placeholder}</Text> : null}
    </Text>)}
  </Box>;
}
