// 纯文本编辑数学：wrap、caret、选区与 undo。

export type Measure = (text: string) => number;

export interface DLine {
  /** 该显示行首字符的全局偏移。 */
  start: number;
  /** 该显示行末字符之后的全局偏移（不含 '\n'）。 */
  end: number;
  /** 软换行（非显式 '\n'）结束。 */
  soft: boolean;
}

/**
 * 按 maxW 对 doc 做贪心软换行。每个源字符恰好落在一行上，
 * 保证 caret ↔ (line, x) 映射全覆盖。
 */
export function layoutDoc(doc: string, maxW: number, measure: Measure): DLine[] {
  const lines: DLine[] = [];
  let offset = 0;
  for (const src of doc.split("\n")) {
    let start = 0;
    while (src.length - start > 0) {
      let w = 0;
      let lastSpace = -1;
      let i = start;
      for (; i < src.length; i++) {
        const cw = measure(src[i]!);
        if (i > start && w + cw > maxW) break;
        w += cw;
        if (src[i] === " ") lastSpace = i;
      }
      if (i >= src.length) {
        lines.push({ start: offset + start, end: offset + src.length, soft: false });
        start = src.length;
      } else {
        const cut = lastSpace >= start ? lastSpace + 1 : i;
        lines.push({ start: offset + start, end: offset + cut, soft: true });
        start = cut;
      }
    }
    if (src.length === 0) {
      lines.push({ start: offset, end: offset, soft: false });
    }
    offset += src.length + 1;
  }
  if (lines.length === 0) lines.push({ start: 0, end: 0, soft: false });
  return lines;
}

/** 软断点上的 caret 归属下一行；硬换行归属行尾。 */
export function caretLine(lines: DLine[], caret: number): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (caret < line.end) return i;
    if (caret === line.end) {
      return line.soft && i + 1 < lines.length ? i + 1 : i;
    }
  }
  return lines.length - 1;
}

/** caret 在其显示行上的 x（px）。 */
export function caretX(doc: string, lines: DLine[], caret: number, measure: Measure): number {
  const line = lines[caretLine(lines, caret)]!;
  return measure(doc.slice(line.start, Math.max(line.start, Math.min(caret, line.end))));
}

/** 点击 (x, lineIndex) 落到最近字符边界。 */
export function caretFromX(
  doc: string,
  lines: DLine[],
  lineIndex: number,
  x: number,
  measure: Measure,
): number {
  const line = lines[Math.max(0, Math.min(lineIndex, lines.length - 1))]!;
  let acc = 0;
  for (let i = line.start; i < line.end; i++) {
    const cw = measure(doc[i]!);
    if (x < acc + cw / 2) return i;
    acc += cw;
  }
  if (line.soft && line.end > line.start && doc[line.end - 1] === " ") {
    return line.end - 1;
  }
  return line.end;
}

export interface EditState {
  doc: string;
  caret: number;
}

export function insertAt(state: EditState, text: string): EditState {
  return {
    doc: state.doc.slice(0, state.caret) + text + state.doc.slice(state.caret),
    caret: state.caret + text.length,
  };
}

export function backspace(state: EditState): EditState {
  if (state.caret === 0) return state;
  return {
    doc: state.doc.slice(0, state.caret - 1) + state.doc.slice(state.caret),
    caret: state.caret - 1,
  };
}

export function del(state: EditState): EditState {
  if (state.caret >= state.doc.length) return state;
  return {
    doc: state.doc.slice(0, state.caret) + state.doc.slice(state.caret + 1),
    caret: state.caret,
  };
}

/** 垂直移动并保持目标列 goalX。 */
export function moveVertical(
  doc: string,
  lines: DLine[],
  caret: number,
  dir: -1 | 1,
  goalX: number,
  measure: Measure,
): number {
  const line = caretLine(lines, caret);
  const target = line + dir;
  if (target < 0) return 0;
  if (target >= lines.length) return doc.length;
  return caretFromX(doc, lines, target, goalX, measure);
}

export function lineStart(lines: DLine[], caret: number): number {
  return lines[caretLine(lines, caret)]!.start;
}

export function lineEnd(lines: DLine[], caret: number): number {
  const line = lines[caretLine(lines, caret)]!;
  if (line.soft && line.end > line.start) return line.end - 1;
  return line.end;
}

export interface SelEdit {
  doc: string;
  caret: number;
  anchor: number;
}

/** 归一化 [lo, hi) 选区。 */
export function selBounds(s: SelEdit): [number, number] {
  return s.caret <= s.anchor ? [s.caret, s.anchor] : [s.anchor, s.caret];
}

export function hasSelection(s: SelEdit): boolean {
  return s.caret !== s.anchor;
}

/** 用 text 替换选区（或在 caret 插入）。 */
export function typeText(s: SelEdit, text: string): SelEdit {
  const [lo, hi] = selBounds(s);
  const caret = lo + text.length;
  return { doc: s.doc.slice(0, lo) + text + s.doc.slice(hi), caret, anchor: caret };
}

/** Backspace：有选区则删选区，否则删左侧一字。 */
export function backspaceSel(s: SelEdit): SelEdit {
  if (hasSelection(s)) return typeText(s, "");
  if (s.caret === 0) return s;
  return {
    doc: s.doc.slice(0, s.caret - 1) + s.doc.slice(s.caret),
    caret: s.caret - 1,
    anchor: s.caret - 1,
  };
}

/** Delete：有选区则删选区，否则删右侧一字。 */
export function deleteSel(s: SelEdit): SelEdit {
  if (hasSelection(s)) return typeText(s, "");
  if (s.caret >= s.doc.length) return s;
  return { doc: s.doc.slice(0, s.caret) + s.doc.slice(s.caret + 1), caret: s.caret, anchor: s.caret };
}

export type EditKind = "type" | "delete" | "other";

export interface History {
  past: SelEdit[];
  future: SelEdit[];
  last: EditKind | null;
}

export const HISTORY_LIMIT = 200;

export function emptyHistory(): History {
  return { past: [], future: [], last: null };
}

/** 记录 before 为 undo 点；同类 type/delete 连续合并。 */
export function recordEdit(h: History, before: SelEdit, kind: EditKind): void {
  h.future.length = 0;
  const merge = kind !== "other" && h.last === kind;
  if (!merge) {
    h.past.push(before);
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
  }
  h.last = kind;
}

/** 导航/点击后打断合并。 */
export function breakRun(h: History): void {
  h.last = null;
}

export function undo(h: History, current: SelEdit): SelEdit | null {
  const state = h.past.pop();
  if (!state) return null;
  h.future.push(current);
  h.last = null;
  return state;
}

export function redo(h: History, current: SelEdit): SelEdit | null {
  const state = h.future.pop();
  if (!state) return null;
  h.past.push(current);
  h.last = null;
  return state;
}
