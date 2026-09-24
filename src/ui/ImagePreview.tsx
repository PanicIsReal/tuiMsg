import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useBoxMetrics, type DOMElement } from "ink";
import type { Attachment, Session } from "../domain/model.ts";
import { activeGraphics, decodeImage, observeImageVisibility, registerImage, repaintImages, type DecodedImage } from "../image-rendering.ts";
import { canvasHex, colors, useTheme } from "./theme.ts";

type PreviewState = { kind: "loading" } | { kind: "ready"; image: DecodedImage } | { kind: "error" };

// Decoded pictures by attachment and size, so one scrolled back into view shows at once.
const decoded = new Map<string, { image: DecodedImage; bytes: number }>();
const DECODED_BUDGET = 48 * 1024 * 1024;
let decodedBytes = 0;

function recall(key: string): DecodedImage | undefined {
  const entry = decoded.get(key);
  if (!entry) return undefined;
  decoded.delete(key);
  decoded.set(key, entry);
  return entry.image;
}

function remember(key: string, image: DecodedImage): void {
  const bytes = image.frames.reduce((total, frame) => total + frame.ansi.length * 2 + (frame.png?.length ?? 0) + (frame.sixel?.reduce((sum, strip) => sum + strip.length * 2, 0) ?? 0), 0);
  if (bytes > DECODED_BUDGET / 4) return;
  const previous = decoded.get(key);
  if (previous) decodedBytes -= previous.bytes;
  decoded.delete(key);
  decoded.set(key, { image, bytes });
  decodedBytes += bytes;
  for (const [oldest, entry] of decoded) {
    if (decodedBytes <= DECODED_BUDGET) break;
    decoded.delete(oldest);
    decodedBytes -= entry.bytes;
  }
}
export type ImagePreviewProps = {
  attachment: Attachment;
  loadAttachment: (attachment: Attachment) => Promise<Uint8Array>;
  width: number;
  height: number;
  delayMs?: number;
};

export function ImagePreview(props: ImagePreviewProps) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [frameIndex, setFrameIndex] = useState(0);
  const ref = useRef<DOMElement>(null);
  useBoxMetrics(ref);
  const [visible, setVisible] = useState(false);
  const theme = useTheme();
  useLayoutEffect(repaintImages);
  useEffect(() => observeImageVisibility(() => {
    if (!ref.current) return;
    const area = measureElement(ref.current);
    let left = area.x;
    let top = area.y;
    let right = area.x + area.width;
    let bottom = area.y + area.height;
    let ancestor = ref.current.parentNode;
    while (ancestor) {
      const bounds = measureElement(ancestor);
      const { overflow, overflowX, overflowY } = ancestor.style;
      if (overflow === "hidden" || overflowX === "hidden") { left = Math.max(left, bounds.x); right = Math.min(right, bounds.x + bounds.width); }
      if (overflow === "hidden" || overflowY === "hidden") { top = Math.max(top, bounds.y); bottom = Math.min(bottom, bounds.y + bounds.height); }
      ancestor = ancestor.parentNode;
    }
    setVisible(right > left && bottom > top);
  }), []);
  useEffect(() => {
    if (!visible) { setState({ kind: "loading" }); return; }
    const graphics = activeGraphics();
    const key = `${props.attachment.guid}|${props.width}x${props.height}|${graphics.protocol}|${graphics.cell.width}x${graphics.cell.height}|${theme}`;
    setFrameIndex(0);
    const cached = recall(key);
    if (cached) { setState({ kind: "ready", image: cached }); return; }
    let active = true;
    const controller = new AbortController();
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      void props.loadAttachment(props.attachment)
        .then(bytes => { if (!active) throw new Error("Preview closed"); return decodeImage(bytes, props.width, props.height, controller.signal, canvasHex(theme)); })
        .then(image => { remember(key, image); if (active) setState({ kind: "ready", image }); })
        .catch(() => { if (active) setState({ kind: "error" }); });
    }, props.delayMs ?? 0);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [props.attachment.guid, props.loadAttachment, props.delayMs, props.width, props.height, visible, theme]);
  const frame = state.kind === "ready" ? state.image.frames[frameIndex] ?? state.image.frames[0] : undefined;
  useEffect(() => {
    if (!visible || state.kind !== "ready" || state.image.frames.length < 2 || !frame) return;
    const timer = setTimeout(() => setFrameIndex(index => (index + 1) % state.image.frames.length), frame.delay);
    return () => clearTimeout(timer);
  }, [state, frameIndex, frame, visible]);
  useEffect(() => {
    const protocol = activeGraphics().protocol;
    // The half-block frame stays underneath as the placeholder a native image covers.
    if (!visible || !frame || state.kind !== "ready" || protocol === "blocks" || (protocol === "sixel" && !frame.sixel)) return;
    return registerImage({ png: frame.png, sixel: protocol === "sixel" ? frame.sixel : undefined, measure: () => {
      if (!ref.current) return null;
      const area = measureElement(ref.current);
      // After a resize the box can shrink before the picture is decoded again at its new size.
      if (state.image.width > area.width || state.image.height > area.height) return null;
      const imageArea = { x: area.x, y: area.y, width: state.image.width, height: state.image.height };
      let ancestor: DOMElement | undefined = ref.current;
      while (ancestor) {
        const bounds = measureElement(ancestor);
        const { overflow, overflowX, overflowY } = ancestor.style;
        if ((overflow === "hidden" || overflowX === "hidden") && (imageArea.x < bounds.x || imageArea.x + imageArea.width > bounds.x + bounds.width)) return null;
        if ((overflow === "hidden" || overflowY === "hidden") && (imageArea.y < bounds.y || imageArea.y + imageArea.height > bounds.y + bounds.height)) return null;
        ancestor = ancestor.parentNode;
      }
      return imageArea;
    } });
  }, [frame, state, visible]);
  return (
    <Box ref={ref} width={props.width} height={props.height} flexShrink={0}>
      <Text wrap="truncate">{frame?.ansi ?? (state.kind === "error" ? "Preview unavailable · o opens original" : "Loading image…")}</Text>
    </Box>
  );
}

export function ImageViewer(props: { attachment: Attachment; session: Session; width: number; height: number }) {
  return (
    <Box width={props.width} height={props.height} borderStyle="round" borderColor={colors.faint} borderBackgroundColor={colors.canvas}
      backgroundColor={colors.canvas} paddingX={1} flexDirection="column">
      <Text wrap="truncate" color={colors.secondary}>{props.attachment.name}</Text>
      <ImagePreview key={props.attachment.guid} attachment={props.attachment} loadAttachment={props.session.loadAttachment}
        width={Math.max(1, props.width - 4)} height={Math.max(1, props.height - 4)} />
      <Text color={colors.subtle}>o open original · s save · esc close</Text>
    </Box>
  );
}
