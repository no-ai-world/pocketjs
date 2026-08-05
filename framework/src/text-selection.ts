// All-Text selection: maps native text hits to a shared guest-side selection overlay.

import { onFramePersistent } from "./frame.ts";
import { getOps } from "./host.ts";
import {
  clearTextSelectionInteraction,
  clearTextSelectionPointer,
  setTextSelectionPointer,
} from "./input.ts";
import type { CopyText, SelectableHandler } from "./host-input.ts";
import { ENUMS, abgr } from "../../contracts/spec/spec.ts";
import {
  createElement,
  insertNode,
  removeNode,
  setProp,
  type NodeMirror,
} from "./native-tree.ts";
import { getOverlayRootOrNull } from "./overlay.ts";
import { DEFAULT_FONT_SLOT, FONT_SLOTS } from "./styles.generated.ts";

const FONT_PX = [12, 14, 16, 18, 20, 24, 36] as const;
const SELECTION_COLOR = abgr(129, 140, 248, 112);

type Point = { x: number; y: number };
type Line = { start: number; end: number };
type TextMetrics = {
  slot: number;
  px: number;
  tracking: number;
  lineHeight: number;
  boxWidth?: number;
  textAlign: number;
};
type Selection = {
  owner: NodeMirror;
  text: string;
  anchor: number;
  caret: number;
  origin: Point;
};

type PaintedRect = { x: number; y: number; width: number; height: number };

let selection: Selection | null = null;
let selectionRects: NodeMirror[] = [];
let paintedRects: PaintedRect[] = [];
let paintedOwner: NodeMirror | null = null;
let paintedRoot: NodeMirror | null = null;

/** Read the complete text represented by a native text element. */
function textContent(node: NodeMirror): string {
  // 读取文本节点内容。
  if (node.text !== undefined) return node.text;
  return node.children.map(textContent).join("");
}

/** Read a finite numeric inline style value. */
function styleNumber(node: NodeMirror, name: string): number | undefined {
  // 读取内联数值样式。
  const value = node.domAttrs?.style;
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[name];
  const number = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

/** Resolve a fixed-width utility from a class token list. */
function fixedWidthClass(tokens: string[]): number | undefined {
  // 解析旧宿主 fallback 可确定的固定文字宽度。
  let width: number | undefined;
  for (const token of tokens) {
    if (token === "w-full") {
      width = undefined;
      continue;
    }
    const match = /^w-(\d+(?:\.\d+)?|\[-?\d+(?:\.\d+)?(?:px)?\])$/.exec(token);
    if (!match) continue;
    const raw = match[1];
    const value = raw.startsWith("[")
      ? Number(raw.slice(1, -1).replace(/px$/, ""))
      : Number(raw) * 4;
    width = Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  return width;
}

/** Infer text metrics when the host lacks native text readback. */
function classMetrics(node: NodeMirror): TextMetrics {
  // 推断文字节点的兼容性度量。
  const className = String(node.domAttrs?.class ?? "");
  const tokens = className.split(/\s+/).filter(Boolean);
  const sizeByName: Record<string, number> = {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    "2xl": 24,
    "4xl": 36,
  };
  let px = 16;
  let bold = false;
  let wide = false;
  let classTextAlign: number = ENUMS.TextAlign.Left;
  let classLineHeight: number | undefined;
  for (const token of tokens) {
    if (token === "font-bold") bold = true;
    if (token === "tracking-wide") wide = true;
    if (token === "text-left") classTextAlign = ENUMS.TextAlign.Left;
    if (token === "text-center") classTextAlign = ENUMS.TextAlign.Center;
    if (token === "text-right") classTextAlign = ENUMS.TextAlign.Right;
    if (token.startsWith("text-")) {
      const candidate = sizeByName[token.slice(5)];
      if (candidate !== undefined) px = candidate;
    }
    if (!token.startsWith("leading-")) continue;
    const raw = token.slice("leading-".length);
    const arbitrary = /^\[(-?\d+(?:\.\d+)?)(?:px)?\]$/.exec(raw);
    const scaled = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 4 : undefined;
    const candidate = arbitrary ? Number(arbitrary[1]) : scaled;
    if (candidate !== undefined && Number.isFinite(candidate) && candidate > 0) classLineHeight = candidate;
  }
  const sizeIndex = FONT_PX.indexOf(px as (typeof FONT_PX)[number]);
  const inferredSlot = sizeIndex >= 0 ? (bold ? 7 + sizeIndex : sizeIndex) : DEFAULT_FONT_SLOT;
  const rawSlot = styleNumber(node, "fontSlot");
  const slot = rawSlot !== undefined && Number.isInteger(rawSlot) && rawSlot >= 0
    ? rawSlot
    : inferredSlot;
  const slotInfo = FONT_SLOTS[slot];
  const slotPx = FONT_PX[slot >= 7 ? slot - 7 : slot];
  const boxWidth = styleNumber(node, "width") ?? fixedWidthClass(tokens);
  const lineHeight = styleNumber(node, "lineHeight") ??
    classLineHeight ??
    slotInfo?.lineHeight ??
    slotPx ??
    px;
  return {
    slot,
    px: slotPx ?? px,
    tracking: styleNumber(node, "tracking") ?? (wide ? 0.025 * px : 0),
    lineHeight,
    boxWidth,
    textAlign: styleNumber(node, "textAlign") ?? classTextAlign,
  };
}

/** Resolve the metrics needed for pointer-to-glyph mapping. */
function textMetrics(node: NodeMirror): TextMetrics {
  // 解析文字节点的原生绘制度量。
  const inferred = classMetrics(node);
  const native = getOps().nodeTextLayout?.(node.id);
  if (
    native &&
    Number.isFinite(native.width) &&
    native.width >= 0 &&
    Number.isInteger(native.fontSlot) &&
    native.fontSlot >= 0 &&
    Number.isFinite(native.textAlign) &&
    Number.isFinite(native.tracking) &&
    Number.isFinite(native.lineHeight) &&
    native.lineHeight > 0
  ) {
    const slot = native.fontSlot;
    return {
      slot,
      px: FONT_PX[slot >= 7 ? slot - 7 : slot] ?? inferred.px,
      tracking: native.tracking,
      lineHeight: native.lineHeight,
      boxWidth: native.width,
      textAlign: native.textAlign,
    };
  }
  return inferred;
}

/** Split a text document into code-unit line ranges. */
function linesOf(text: string): Line[] {
  // 划分文本行的代码单元范围。
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index === text.length || text[index] === "\n") {
      lines.push({ start, end: index });
      start = index + 1;
    }
  }
  return lines;
}

/** Count visible glyphs for the native tracking contribution. */
function glyphCount(text: string): number {
  // 统计文本中的可见字形。
  let count = 0;
  for (const char of text) if (char !== "\n") count++;
  return count;
}

/** Measure one text prefix using the host's baked font metrics. */
function measure(node: NodeMirror, text: string, metrics: TextMetrics): number {
  // 测量一段文本的绘制宽度。
  if (!text) return 0;
  return getOps().measureText(text, metrics.slot) + glyphCount(text) * metrics.tracking;
}

/** Return UTF-16 boundaries that do not split a Unicode code point. */
function boundaries(text: string, start: number, end: number): number[] {
  // 生成不拆分 Unicode 代码点的边界。
  const result = [start];
  for (let index = start; index < end;) {
    const codePoint = text.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    result.push(index);
  }
  return result;
}

/** Move a caret by one Unicode code point boundary. */
function moveBoundary(text: string, current: number, direction: -1 | 1): number {
  // 移动一个 Unicode 代码点边界。
  const points = boundaries(text, 0, text.length);
  if (direction < 0) {
    for (let index = points.length - 1; index >= 0; index--) {
      if (points[index] < current) return points[index];
    }
    return 0;
  }
  for (const point of points) if (point > current) return point;
  return text.length;
}

/** Resolve the horizontal offset of one aligned native text line. */
function alignmentOffset(node: NodeMirror, lineText: string, metrics: TextMetrics): number {
  // 计算一行对齐后的水平偏移。
  if (metrics.boxWidth === undefined) return 0;
  const lineWidth = measure(node, lineText, metrics);
  if (metrics.textAlign === ENUMS.TextAlign.Center) return (metrics.boxWidth - lineWidth) * 0.5;
  if (metrics.textAlign === ENUMS.TextAlign.Right) return metrics.boxWidth - lineWidth;
  return 0;
}

/** Map a local pointer coordinate to the nearest text offset. */
function offsetAt(node: NodeMirror, local: Point, text: string, metrics: TextMetrics): number {
  // 将本地指针位置映射为文本偏移。
  const lines = linesOf(text);
  const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor(Math.max(0, local.y) / metrics.lineHeight)));
  const line = lines[lineIndex];
  const boundariesInLine = boundaries(text, line.start, line.end);
  const lineText = text.slice(line.start, line.end);
  const alignOffset = alignmentOffset(node, lineText, metrics);
  const x = local.x - alignOffset;
  let nearest = line.start;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const boundary of boundariesInLine) {
    const distance = Math.abs(measure(node, text.slice(line.start, boundary), metrics) - x);
    if (distance < nearestDistance) {
      nearest = boundary;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Map a screen point into a text node's local coordinate system. */
function localPoint(node: NodeMirror, x: number, y: number): Point | null {
  // 将屏幕指针位置映射到文字节点本地坐标。
  const ops = getOps();
  const raw = ops.nodeLocalPoint?.(node.id, x, y);
  if (raw === undefined) return { x, y };
  if (raw === null) return null;
  if (typeof raw === "number") {
    if (raw === 0) return null;
    const localX = ops.nodeLocalX?.();
    const localY = ops.nodeLocalY?.();
    return localX !== undefined && localY !== undefined &&
        Number.isFinite(localX) && Number.isFinite(localY)
      ? { x: localX, y: localY }
      : null;
  }
  return Number.isFinite(raw.x) && Number.isFinite(raw.y) ? raw : null;
}

/** Remove the currently painted selection rectangles. */
function removeSelectionRects(): void {
  // 移除当前选区的视觉矩形。
  const root = getOverlayRootOrNull();
  for (const rect of selectionRects) {
    if (rect.parent && rect.parent === root) removeNode(rect.parent, rect);
    else rect.parent = null;
  }
  selectionRects = [];
  paintedRects = [];
  paintedOwner = null;
  paintedRoot = null;
}

/** Map one node-local selection rectangle into screen space. */
function screenRect(
  owner: NodeMirror,
  origin: Point,
  x: number,
  y: number,
  width: number,
  height: number,
): PaintedRect | null {
  // 将选区局部矩形映射到屏幕坐标。
  const mapper = getOps().nodeTextSelectionRect ?? getOps().nodeScreenRect;
  if (mapper) {
    const mapped = mapper(owner.id, x, y, width, height);
    if (
      mapped &&
      Number.isFinite(mapped.x) &&
      Number.isFinite(mapped.y) &&
      Number.isFinite(mapped.width) &&
      Number.isFinite(mapped.height) &&
      mapped.width >= 0 &&
      mapped.height >= 0
    ) {
      return mapped;
    }
    return null;
  }
  return { x: origin.x + x, y: origin.y + y, width, height };
}

/** Paint the current selection as translucent screen-space rectangles. */
function paintSelection(): void {
  // 绘制当前选区的视觉矩形。
  if (!selection || selection.anchor === selection.caret) {
    removeSelectionRects();
    return;
  }
  const root = getOverlayRootOrNull();
  if (!root) {
    removeSelectionRects();
    return;
  }
  const text = textContent(selection.owner);
  const metrics = textMetrics(selection.owner);
  const [lo, hi] = selection.anchor < selection.caret
    ? [selection.anchor, selection.caret]
    : [selection.caret, selection.anchor];
  const nextRects: PaintedRect[] = [];
  for (const [lineIndex, line] of linesOf(text).entries()) {
    const start = Math.max(lo, line.start);
    const end = Math.min(hi, line.end);
    if (start >= end) continue;
    const lineText = text.slice(line.start, line.end);
    const x = alignmentOffset(selection.owner, lineText, metrics) +
      measure(selection.owner, text.slice(line.start, start), metrics);
    const width = Math.max(1, measure(selection.owner, text.slice(line.start, end), metrics) -
      measure(selection.owner, text.slice(line.start, start), metrics));
    const mapped = screenRect(
      selection.owner,
      selection.origin,
      x,
      lineIndex * metrics.lineHeight,
      width,
      metrics.lineHeight,
    );
    if (mapped) nextRects.push(mapped);
  }
  const unchanged =
    paintedOwner === selection.owner &&
    paintedRoot === root &&
    paintedRects.length === nextRects.length &&
    paintedRects.every((rect, index) => {
      const next = nextRects[index];
      return rect.x === next.x && rect.y === next.y &&
        rect.width === next.width && rect.height === next.height;
    });
  if (unchanged) return;

  removeSelectionRects();
  for (const next of nextRects) {
    const rect = createElement("view");
    rect.hitTarget = selection.owner;
    setProp(rect, "style", {
      width: next.width,
      height: next.height,
      posType: ENUMS.PosType.Absolute,
      insetL: next.x,
      insetT: next.y,
      bgColor: SELECTION_COLOR,
    }, undefined);
    insertNode(root, rect);
    selectionRects.push(rect);
  }
  paintedRects = nextRects;
  paintedOwner = selection.owner;
  paintedRoot = root;
}

/** Keep a selection valid while its owner's reactive text changes. */
export function reconcileTextSelection(): void {
  // 协调响应式文字变化后的选区范围。
  if (!selection) return;
  if (!selection.owner.parent) {
    clearTextSelection();
    return;
  }
  const text = textContent(selection.owner);
  if (text !== selection.text) {
    selection.text = text;
    selection.anchor = Math.min(selection.anchor, text.length);
    selection.caret = Math.min(selection.caret, text.length);
  }
  paintSelection();
}

onFramePersistent(() => {
  // 在 Solid 帧循环中协调文字选区。
  reconcileTextSelection();
});

/** Clear the shared text selection and its visual overlay. */
export function clearTextSelection(): void {
  // 清除共享文字选区。
  selection = null;
  clearTextSelectionPointer();
  removeSelectionRects();
}

/** Create the selection behavior attached to one native Text element. */
export function createTextSelectionHandler(node: NodeMirror): SelectableHandler {
  // 创建一个文字节点的选择行为。
  let previousDown = false;
  let pointerStart: Point | null = null;
  let dragged = false;

  const pointer = (x: number, y: number, down: boolean, shift: boolean): void => {
    // 处理文字节点的指针选择。
    const text = textContent(node);
    const metrics = textMetrics(node);
    const local = localPoint(node, x, y);
    if (!local) {
      clearTextSelection();
      previousDown = down;
      pointerStart = null;
      dragged = false;
      return;
    }
    const offset = offsetAt(node, local, text, metrics);
    if (down && !previousDown) {
      pointerStart = { x, y };
      dragged = false;
      setTextSelectionPointer(node, true, false);
      const sameOwner = selection?.owner === node;
      const anchor = sameOwner && shift ? selection!.anchor : offset;
      selection = {
        owner: node,
        text,
        anchor,
        caret: offset,
        origin: { x: x - local.x, y: y - local.y },
      };
      paintSelection();
    } else if (down) {
      if (pointerStart && Math.abs(x - pointerStart.x) + Math.abs(y - pointerStart.y) >= 3) dragged = true;
      setTextSelectionPointer(node, true, dragged);
      if (selection?.owner === node) {
        selection.caret = offset;
        paintSelection();
      }
    } else if (previousDown && selection?.owner === node) {
      setTextSelectionPointer(node, false, dragged);
      selection.caret = offset;
      paintSelection();
      pointerStart = null;
      dragged = false;
    }
    previousDown = down;
  };

  const key = (keyName: string, shift: boolean, copy: CopyText): void => {
    // 处理文字节点的选择按键。
    if (keyName === "Escape") {
      clearTextSelectionInteraction();
      return;
    }
    if (!selection || selection.owner !== node) return;
    const text = textContent(node);
    selection.text = text;
    switch (keyName) {
      case "SelectAll":
        selection.anchor = 0;
        selection.caret = text.length;
        paintSelection();
        return;
      case "Copy": {
        const [lo, hi] = selection.anchor < selection.caret
          ? [selection.anchor, selection.caret]
          : [selection.caret, selection.anchor];
        if (lo !== hi) copy(text.slice(lo, hi));
        return;
      }
      case "Left":
      case "Right": {
        const direction: -1 | 1 = keyName === "Left" ? -1 : 1;
        const current = selection.caret;
        const next = moveBoundary(text, current, direction);
        selection.caret = next;
        if (!shift) selection.anchor = next;
        paintSelection();
        return;
      }
      case "Home":
      case "End": {
        const caret = selection.caret;
        const line = linesOf(text).find((item) => caret >= item.start && caret <= item.end)
          ?? linesOf(text)[0];
        selection.caret = keyName === "Home" ? line.start : line.end;
        if (!shift) selection.anchor = selection.caret;
        paintSelection();
        return;
      }
      default:
        return;
    }
  };

  return {
    active: () => true,
    onKey: key,
    onPointer: pointer,
    onCancel: () => {
      // 重置文字节点的指针选择。
      previousDown = false;
      pointerStart = null;
      dragged = false;
      clearTextSelectionPointer();
    },
  };
}
