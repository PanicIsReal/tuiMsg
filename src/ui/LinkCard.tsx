import { useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useBoxMetrics, type DOMElement } from "ink";
import type { HttpUrl, LinkPreview } from "../domain/model.ts";
import { linkCardLine, previewFromUrl } from "../links.ts";
import { observeImageVisibility } from "../image-rendering.ts";
import { useMouse } from "./mouse.tsx";
import { colors } from "./theme.ts";

export type LinkCardProps = {
  url: HttpUrl;
  loadLinkPreview?: (url: HttpUrl) => Promise<LinkPreview>;
  width: number;
  delayMs?: number;
  onOpen?: () => void;
};

export function LinkCard(props: LinkCardProps) {
  const [preview, setPreview] = useState<LinkPreview>(() => previewFromUrl(props.url));
  useEffect(() => { setPreview(previewFromUrl(props.url)); }, [props.url]);
  const ref = useRef<DOMElement>(null);
  useBoxMetrics(ref);
  const [visible, setVisible] = useState(false);
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
    if (!visible || !props.loadLinkPreview) return;
    let active = true;
    const timer = setTimeout(() => {
      void props.loadLinkPreview?.(props.url)
        .then((next) => { if (active) setPreview(next); })
        .catch(() => undefined);
    }, props.delayMs ?? 0);
    return () => { active = false; clearTimeout(timer); };
  }, [props.url, props.loadLinkPreview, props.delayMs, visible]);
  useMouse(ref, (event) => {
    if (event.kind !== "click" || event.button !== "left") return false;
    props.onOpen?.();
    return true;
  });
  return (
    <Box ref={ref} width={props.width} flexShrink={0}>
      <Text wrap="truncate-end" color={colors.secondary}>{linkCardLine(preview)}</Text>
    </Box>
  );
}
