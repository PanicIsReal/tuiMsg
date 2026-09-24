import { isMouseSequence } from "./mouse.tsx";
import stringWidth from "string-width";
import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useBoxMetrics, type DOMElement } from "ink";
import { colors } from "./theme.ts";
import { cleanText } from "../domain/text.ts";

// Wraps the characters into rows of `width` cells, the way the input shows them: a newline
// starts a row, and one extra cell at the end holds the caret. `starts` holds the index of
// each row's first character.
export function inputLines(characters: string[], cursor: number, width: number): { lines: { text: string; index: number }[][]; starts: number[]; cursorRow: number } {
  const lines: { text: string; index: number }[][] = [[]];
  const starts = [0];
  let column = 0;
  let cursorRow = 0;
  for (let index = 0; index <= characters.length; index++) {
    const character = characters[index] ?? " ";
    const cells = cellsOf(character);
    if (column > 0 && column + cells > Math.max(1, width)) { lines.push([]); starts.push(index); column = 0; }
    if (index === cursor) cursorRow = lines.length - 1;
    if (character !== "\n" || index === cursor) lines.at(-1)!.push({ text: character === "\n" ? " " : character, index });
    if (character === "\n") { lines.push([]); starts.push(index + 1); column = 0; }
    else column += cells;
  }
  return { lines, starts, cursorRow };
}

const cellsOf = (character: string) => character === "\n" ? 1 : stringWidth(character);

// Where the caret lands moving one row up or down: the same column where the row reaches it,
// else the row's end. Rows are the wrapped ones on screen, not just the lines between breaks.
export function verticalMove(characters: string[], cursor: number, width: number, delta: -1 | 1): number {
  const { starts, cursorRow } = inputLines(characters, cursor, width);
  const target = cursorRow + delta;
  if (target < 0 || target >= starts.length) return cursor;
  let column = 0;
  for (let index = starts[cursorRow]!; index < cursor; index++) column += cellsOf(characters[index]!);
  const end = (starts[target + 1] ?? characters.length + 1) - 1;
  let x = 0;
  for (let index = starts[target]!; index < end; index++) {
    x += cellsOf(characters[index]!);
    if (x > column) return index;
  }
  return end;
}

// How many rows a value takes at `width`, so its box can grow to show them.
export function inputRowCount(value: string, width: number): number {
  return inputLines(Array.from(value), -1, width).lines.length;
}

export function TextInput(props: {
  value: string; onChange: (value: string) => void; onSubmit: () => void;
  focused: boolean; placeholder?: string; multiline?: boolean; rows?: number;
  // The width to wrap at when the parent knows it; otherwise the measured width, which is
  // not known until after the first frame.
  width?: number;
}) {
  const box = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(box);
  const width = props.width ?? metrics.width;
  const [position, setPosition] = useState(Array.from(props.value).length);
  const editing = useRef({ value: props.value, cursor: position });
  const submitLatest = useRef(props.onSubmit);
  submitLatest.current = props.onSubmit;
  const clean = (text: string) => props.multiline ? cleanText(text) : cleanText(text).replace(/\n/g, "");
  useEffect(() => { editing.current = { value: props.value, cursor: Math.min(editing.current.cursor, Array.from(props.value).length) }; }, [props.value]);
  const characters = Array.from(props.value);
  const cursor = Math.min(position, characters.length);
  useEffect(() => { if (!props.value) setPosition(0); }, [props.value]);
  usePaste(text => {
    const characters = Array.from(editing.current.value);
    const cursor = editing.current.cursor;
    const value = clean(text);
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
    if (key.upArrow || key.downArrow) { move(verticalMove(characters, cursor, width, key.upArrow ? -1 : 1)); return; }
    if (key.return || key.ctrl && input === "j" || input === "\n") {
      if (props.multiline && (key.shift || key.meta || key.ctrl || input === "\n")) edit(cursor, cursor, "\n");
      else props.onSubmit();
      return;
    }
    // Over SSH, text typed just before Enter often arrives in the same read ("ok\r").
    // Insert it, then submit once the parent has rendered the new value.
    if (!key.meta && !key.ctrl && input.length > 1 && input.endsWith("\r") && !input.slice(0, -1).includes("\r")) {
      edit(cursor, cursor, clean(input.slice(0, -1)));
      setTimeout(() => submitLatest.current(), 0);
      return;
    }
    if (input && !key.meta && !key.ctrl) edit(cursor, cursor, clean(input));
  }, { isActive: props.focused });
  const { lines, cursorRow } = inputLines(characters, cursor, width);
  const rowCount = props.rows ?? 4;
  const start = Math.max(0, cursorRow - rowCount + 1);
  return <Box ref={box} width="100%" flexDirection="column">
    {lines.slice(start, start + rowCount).map((line, row) => <Text key={start + row} color={colors.text}>
      {line.map(cell => <Text key={cell.index} inverse={props.focused && cell.index === cursor}>{cell.text}</Text>)}
      {!props.value && row === 0 ? <Text color={colors.subtle}>{props.placeholder}</Text> : null}
    </Text>)}
  </Box>;
}
