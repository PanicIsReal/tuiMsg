import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useBoxMetrics, type DOMElement } from "ink";
import type { Attachment, Session } from "../domain/model.ts";
import { decodeImage, observeImageVisibility, registerImage, repaintImages, supportsNativeImages, type DecodedImage } from "../image-rendering.ts";
import { colors } from "./theme.ts";

type PreviewState = { kind: "loading" } | { kind: "ready"; image: DecodedImage } | { kind: "error" };
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
    let active = true;
    const controller = new AbortController();
    setState({ kind: "loading" });
    setFrameIndex(0);
    const timer = setTimeout(() => {
      void props.loadAttachment(props.attachment)
        .then(bytes => { if (!active) throw new Error("Preview closed"); return decodeImage(bytes, props.width, props.height, controller.signal); })
        .then(image => { if (active) setState({ kind: "ready", image }); })
        .catch(() => { if (active) setState({ kind: "error" }); });
    }, props.delayMs ?? 0);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [props.attachment.guid, props.loadAttachment, props.delayMs, props.width, props.height, visible]);
  const frame = state.kind === "ready" ? state.image.frames[frameIndex] ?? state.image.frames[0] : undefined;
  useEffect(() => {
    if (!visible || state.kind !== "ready" || state.image.frames.length < 2 || !frame) return;
    const timer = setTimeout(() => setFrameIndex(index => (index + 1) % state.image.frames.length), frame.delay);
    return () => clearTimeout(timer);
  }, [state, frameIndex, frame, visible]);
  useEffect(() => {
    if (!visible || !frame || state.kind !== "ready" || !supportsNativeImages()) return;
    return registerImage({ png: frame.png, measure: () => {
      if (!ref.current) return null;
      const area = measureElement(ref.current);
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
    <Box width={props.width} height={props.height} borderStyle="round" borderColor={colors.focus} borderBackgroundColor={colors.panel}
      backgroundColor={colors.panel} paddingX={1} flexDirection="column">
      <Text wrap="truncate" color={colors.text}>{props.attachment.name}</Text>
      <ImagePreview key={props.attachment.guid} attachment={props.attachment} loadAttachment={props.session.loadAttachment}
        width={Math.max(1, props.width - 4)} height={Math.max(1, props.height - 4)} />
      <Text color={colors.secondary}>o open original · s save · Esc close</Text>
    </Box>
  );
}
