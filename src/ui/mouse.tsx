import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { measureElement, useInput, useStdin, useStdout, type DOMElement } from "ink";

export type MouseButton = "left" | "middle" | "right";
export type MouseEvent =
  | { kind: "click"; button: MouseButton; x: number; y: number }
  | { kind: "wheel"; direction: "up" | "down"; x: number; y: number };
export type MouseHandler = (event: MouseEvent) => boolean | void;

type Registration = { ref: React.RefObject<DOMElement | null>; handler: MouseHandler };
type MouseContextValue = { register(registration: Registration): () => void };
const MouseContext = createContext<MouseContextValue | null>(null);

export function MouseProvider(props: { children: React.ReactNode }): React.ReactElement {
  const registrations = useRef<Registration[]>([]);
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const value = useMemo<MouseContextValue>(() => ({
    register(registration) {
      registrations.current.push(registration);
      return () => { registrations.current = registrations.current.filter(item => item !== registration); };
    },
  }), []);

  useEffect(() => {
    if (!isRawModeSupported || !stdout.isTTY) return;
    stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => { stdout.write("\x1b[?1006l\x1b[?1000l"); };
  }, [isRawModeSupported, stdout]);

  useInput((input) => {
    const event = parseMouseEvent(input);
    if (!event) return;
    const hits = registrations.current.flatMap(registration => {
      const node = registration.ref.current;
      if (!node) return [];
      const box = measureElement(node);
      if (event.x < box.x || event.x >= box.x + box.width || event.y < box.y || event.y >= box.y + box.height) return [];
      let depth = 0;
      let ancestor = node.parentNode;
      while (ancestor) {
        depth++;
        const bounds = measureElement(ancestor);
        const { overflow, overflowX, overflowY } = ancestor.style;
        if ((overflow === "hidden" || overflowX === "hidden") && (event.x < bounds.x || event.x >= bounds.x + bounds.width)) return [];
        if ((overflow === "hidden" || overflowY === "hidden") && (event.y < bounds.y || event.y >= bounds.y + bounds.height)) return [];
        ancestor = ancestor.parentNode;
      }
      return [{ registration, depth }];
    }).sort((a, b) => b.depth - a.depth);
    for (const { registration } of hits) {
      if (registration.handler(event) !== false) return;
    }
  });

  return <MouseContext.Provider value={value}>{props.children}</MouseContext.Provider>;
}

export function useMouse(ref: React.RefObject<DOMElement | null>, handler: MouseHandler): void {
  const context = useContext(MouseContext);
  const currentHandler = useRef(handler);
  currentHandler.current = handler;
  if (!context) throw new Error("useMouse must be used inside MouseProvider");
  useEffect(() => {
    const entry: Registration = { ref, handler: event => currentHandler.current(event) };
    return context.register(entry);
  }, [context, ref]);
}

export function parseMouseEvent(input: string): MouseEvent | undefined {
  const sequence = input.startsWith("\x1b") ? input : `\x1b${input}`;
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(sequence);
  if (sgr) {
    const [, rawButton, rawX, rawY, action] = sgr;
    return decodeMouse(Number(rawButton), Number(rawX) - 1, Number(rawY) - 1, action === "M");
  }
  if (sequence.length === 6 && sequence.startsWith("\x1b[M")) {
    return decodeMouse(sequence.charCodeAt(3) - 32, sequence.charCodeAt(4) - 33, sequence.charCodeAt(5) - 33, true);
  }
  return undefined;
}

export function isMouseSequence(input: string): boolean {
  const sequence = input.startsWith("\x1b") ? input : `\x1b${input}`;
  return parseMouseEvent(input) !== undefined || /^\x1b(?:\[<?[0-9;]*[mM]?|\[M.{0,3})$/.test(sequence);
}

function decodeMouse(button: number, x: number, y: number, pressed: boolean): MouseEvent | undefined {
  if (button & 64) return { kind: "wheel", direction: (button & 1) === 0 ? "up" : "down", x, y };
  if (!pressed) return undefined;
  const base = button & 3;
  const mapped: MouseButton | undefined = base === 0 ? "left" : base === 1 ? "middle" : base === 2 ? "right" : undefined;
  return mapped ? { kind: "click", button: mapped, x, y } : undefined;
}
