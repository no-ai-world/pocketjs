// 通用受控 TextInput：单行/多行，消费壳文本流。

import {
  createEffect,
  createMemo,
  createSignal,
  mergeProps,
  onCleanup,
  type JSX as SolidJSX,
} from "solid-js";
import { View, Text, type ViewProps } from "./primitives.ts";
import { onFrame } from "./frame.ts";
import { focusNode, getFocused } from "./input.ts";
import {
  registerEditable,
  type EditableHandler,
  connectHostInput,
  installHostInputPump,
} from "./host-input.ts";
import {
  backspaceSel,
  breakRun,
  caretFromX,
  caretLine,
  caretX,
  deleteSel,
  emptyHistory,
  hasSelection,
  layoutDoc,
  lineEnd,
  lineStart,
  moveVertical,
  recordEdit,
  redo,
  selBounds,
  typeText,
  undo,
  type History,
  type Measure,
  type SelEdit,
} from "./text-edit.ts";
import { getOps } from "./host.ts";
import type { NodeMirror } from "./native-tree.ts";

const DEFAULT_LINE_H = 20;
const CARET_W = 2;

export interface TextInputProps {
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** false=单行（Enter 提交）；true=多行（Enter 换行）。 */
  multiline?: boolean;
  /** 测量函数；默认 body 槽 measureText。 */
  measure?: Measure;
  lineHeight?: number;
  maxWidth?: number;
  class?: string;
  style?: ViewProps["style"];
  /** 聚焦时外层 class。 */
  focusClass?: string;
  caretClass?: string;
  selectionClass?: string;
  placeholderClass?: string;
  textClass?: string;
  preeditClass?: string;
  debugName?: string;
  /** 屏幕坐标 → 字段本地坐标；缺省时点击只聚焦并把 caret 放到末尾。 */
  toLocal?: (x: number, y: number) => { x: number; y: number };
}

function defaultMeasure(text: string): number {
  if (text === "") return 0;
  return getOps().measureText(text, 1); // FONT_BODY slot（14px）
}

/**
 * 官方可复用文本输入。声明 input.text 后即可使用：
 * 受控 value、placeholder、disabled；onChange / onSubmit / onBlur；
 * caret、选区、IME preedit、剪贴板粘贴由框架消费壳事件完成。
 */
export function TextInput(props: TextInputProps): SolidJSX.Element {
  const p = mergeProps(
    {
      multiline: false,
      disabled: false,
      lineHeight: DEFAULT_LINE_H,
      measure: defaultMeasure as Measure,
      class: "relative flex-row items-center px-2 py-1 rounded-md bg-white border-slate-300",
      focusClass: "border-indigo-500",
      caretClass: "bg-indigo-600",
      selectionClass: "bg-indigo-200",
      placeholderClass: "text-sm text-slate-400",
      textClass: "text-sm text-slate-900",
      preeditClass: "text-sm text-slate-900 underline",
    },
    props,
  );

  // 安装一次壳输入泵（无宿主时 no-op）
  installHostInputPump();

  const [node, setNode] = createSignal<NodeMirror | null>(null);
  const [caret, setCaret] = createSignal(0);
  const [anchor, setAnchor] = createSignal(0);
  const [preedit, setPreedit] = createSignal<{ text: string; cursor: number } | null>(null);
  const [focused, setFocused] = createSignal(false);
  const [blink, setBlink] = createSignal(true);
  let goalX = 0;
  let goalSticky = false;
  let prevDown = false;
  const history: History = emptyHistory();
  const host = connectHostInput();

  const measure = () => p.measure;
  const maxW = () => p.maxWidth ?? 10_000;

  const displayDoc = createMemo(() => {
    const pe = preedit();
    if (!pe) return p.value;
    const c = Math.min(caret(), p.value.length);
    return p.value.slice(0, c) + pe.text + p.value.slice(c);
  });
  const displayCaret = createMemo(() => {
    const pe = preedit();
    return pe ? caret() + pe.cursor : caret();
  });
  const lines = createMemo(() => layoutDoc(displayDoc(), maxW(), measure()));
  const sel = createMemo(() => {
    if (caret() === anchor()) return null;
    const [lo, hi] = selBounds({ doc: p.value, caret: caret(), anchor: anchor() });
    return { lo, hi };
  });

  createEffect(() => {
    // 外部 value 缩短时夹紧 caret
    const len = p.value.length;
    if (caret() > len) setCaret(len);
    if (anchor() > len) setAnchor(len);
  });

  const apply = (next: SelEdit, kind: "type" | "delete" | "other", record = true) => {
    if (p.disabled) return;
    if (record) {
      recordEdit(history, { doc: p.value, caret: caret(), anchor: anchor() }, kind);
    }
    setCaret(next.caret);
    setAnchor(next.anchor);
    if (next.doc !== p.value) p.onChange?.(next.doc);
    setBlink(true);
  };

  const state = (): SelEdit => ({ doc: p.value, caret: caret(), anchor: anchor() });

  const handleChars = (text: string) => {
    if (p.disabled || !focused()) return;
    setPreedit(null);
    apply(typeText(state(), text), "type");
  };

  const handlePaste = (text: string) => {
    if (p.disabled || !focused()) return;
    setPreedit(null);
    apply(typeText(state(), text), "other");
  };

  const handleIme = (text: string, cursor: number | null) => {
    if (p.disabled || !focused()) return;
    if (text === "") {
      setPreedit(null);
      return;
    }
    if (hasSelection(state())) apply(typeText(state(), ""), "other");
    setPreedit({ text, cursor: Math.min(cursor ?? text.length, text.length) });
    setBlink(true);
  };

  const handleKey = (key: string, shift: boolean) => {
    if (p.disabled || !focused()) return;
    if (preedit()) return; // 组字中由 IME 吃键

    const extend = (pos: number) => {
      breakRun(history);
      setCaret(Math.max(0, Math.min(p.value.length, pos)));
      // anchor 不动
      setBlink(true);
    };
    const collapseOr = (edge: "lo" | "hi", move: (s: SelEdit) => number) => {
      breakRun(history);
      const s = state();
      if (hasSelection(s)) {
        const [lo, hi] = selBounds(s);
        const pos = edge === "lo" ? lo : hi;
        setCaret(pos);
        setAnchor(pos);
      } else {
        const pos = move(s);
        setCaret(pos);
        setAnchor(pos);
      }
      setBlink(true);
    };

    switch (key) {
      case "Backspace":
        apply(backspaceSel(state()), "delete");
        return;
      case "Delete":
        apply(deleteSel(state()), "delete");
        return;
      case "Enter":
        if (p.multiline) {
          apply(typeText(state(), "\n"), "type");
        } else {
          p.onSubmit?.(p.value);
        }
        return;
      case "Escape":
        setPreedit(null);
        return;
      case "Left":
        if (shift) extend(caret() - 1);
        else collapseOr("lo", (s) => Math.max(0, s.caret - 1));
        goalSticky = false;
        return;
      case "Right":
        if (shift) extend(caret() + 1);
        else collapseOr("hi", (s) => Math.min(s.doc.length, s.caret + 1));
        goalSticky = false;
        return;
      case "Home":
        if (shift) extend(lineStart(lines(), caret()));
        else collapseOr("lo", (s) => lineStart(lines(), s.caret));
        goalSticky = false;
        return;
      case "End":
        if (shift) extend(lineEnd(lines(), caret()));
        else collapseOr("hi", (s) => lineEnd(lines(), s.caret));
        goalSticky = false;
        return;
      case "Up":
      case "Down": {
        if (!p.multiline) return;
        const dir: -1 | 1 = key === "Up" ? -1 : 1;
        if (!goalSticky) {
          goalX = caretX(displayDoc(), lines(), displayCaret(), measure());
          goalSticky = true;
        }
        const next = moveVertical(p.value, lines(), caret(), dir, goalX, measure());
        if (shift) extend(next);
        else {
          breakRun(history);
          setCaret(next);
          setAnchor(next);
        }
        return;
      }
      case "Copy": {
        if (!host || !sel()) return;
        const [lo, hi] = selBounds(state());
        host.send({ t: "copy", text: p.value.slice(lo, hi) });
        return;
      }
      case "Cut": {
        if (!host || !sel()) return;
        const [lo, hi] = selBounds(state());
        host.send({ t: "copy", text: p.value.slice(lo, hi) });
        apply(typeText(state(), ""), "other");
        return;
      }
      case "Undo": {
        const back = undo(history, state());
        if (back) apply(back, "other", false);
        return;
      }
      case "Redo": {
        const fwd = redo(history, state());
        if (fwd) apply(fwd, "other", false);
        return;
      }
      default:
        return;
    }
  };

  const placeCaret = (localX: number, localY: number, shift: boolean) => {
    const lh = p.lineHeight;
    const lineIndex = Math.max(0, Math.floor(localY / lh));
    const pos = caretFromX(p.value, lines(), lineIndex, localX, measure());
    breakRun(history);
    setCaret(pos);
    if (!shift) setAnchor(pos);
    setPreedit(null);
    setBlink(true);
    goalSticky = false;
  };

  const handlePointer = (x: number, y: number, down: boolean, shift: boolean) => {
    if (p.disabled) return;
    const n = node();
    if (!n) return;
    const local = p.toLocal?.(x, y);
    if (down && !prevDown) {
      focusNode(n);
      setFocused(true);
      if (local) {
        placeCaret(local.x, local.y, shift);
      } else if (!shift) {
        breakRun(history);
        const end = p.value.length;
        setCaret(end);
        setAnchor(end);
        setPreedit(null);
      }
    } else if (down && local) {
      const lh = p.lineHeight;
      const lineIndex = Math.max(0, Math.floor(local.y / lh));
      const pos = caretFromX(p.value, lines(), lineIndex, local.x, measure());
      setCaret(pos);
    }
    prevDown = down;
  };

  createEffect(() => {
    const n = node();
    if (!n) return;
    const handler: EditableHandler = {
      active: () => !p.disabled && getFocused() === n,
      onChars: handleChars,
      onKey: handleKey,
      onPaste: handlePaste,
      onIme: handleIme,
      onPointer: handlePointer,
      onBlur: () => {
        setFocused(false);
        setPreedit(null);
        p.onBlur?.();
      },
      caretRect: () => {
        if (getFocused() !== n) return null;
        const row = caretLine(lines(), displayCaret());
        const x = caretX(displayDoc(), lines(), displayCaret(), measure());
        return { x, y: row * p.lineHeight, h: p.lineHeight };
      },
    };
    registerEditable(n, handler);
    onCleanup(() => registerEditable(n, null));
  });

  // 焦点跟踪 + caret 闪烁
  let blinkFrames = 0;
  onFrame(() => {
    const n = node();
    const isFocus = n !== null && getFocused() === n;
    if (isFocus !== focused()) {
      if (!isFocus && focused()) p.onBlur?.();
      setFocused(isFocus);
      if (!isFocus) setPreedit(null);
    }
    if (isFocus) {
      blinkFrames++;
      if (blinkFrames % 30 === 0) setBlink((b) => !b);
    } else {
      blinkFrames = 0;
      setBlink(true);
    }
  });

  const showPlaceholder = () => p.value === "" && !preedit() && !!p.placeholder;
  const caretRow = () => caretLine(lines(), displayCaret());
  const caretPx = () => caretX(displayDoc(), lines(), displayCaret(), measure());

  const selRects = createMemo(() => {
    const s = sel();
    if (!s) return [] as { x: number; y: number; w: number; h: number }[];
    const doc = p.value;
    const ls = lines();
    const out: { x: number; y: number; w: number; h: number }[] = [];
    const lh = p.lineHeight;
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i]!;
      const lo = Math.max(s.lo, line.start);
      const hi = Math.min(s.hi, line.end);
      if (lo >= hi) continue;
      const x0 = measure()(doc.slice(line.start, lo));
      const x1 = measure()(doc.slice(line.start, hi));
      out.push({ x: x0, y: i * lh, w: Math.max(1, x1 - x0), h: lh });
    }
    return out;
  });

  return (
    <View
      ref={setNode}
      focusable={!p.disabled}
      focusKind="editable"
      debugName={p.debugName ?? "TextInput"}
      class={[p.class, focused() ? p.focusClass : ""].filter(Boolean).join(" ")}
      style={p.style}
      onPress={() => {
        if (p.disabled) return;
        const n = node();
        if (n) {
          focusNode(n);
          setFocused(true);
        }
      }}
    >
      {showPlaceholder() ? (
        <Text class={p.placeholderClass}>{p.placeholder}</Text>
      ) : (
        <View class="relative flex-col" style={{ width: maxW() === 10_000 ? undefined : maxW() }}>
          {selRects().map((r) => (
            <View
              class={["absolute", p.selectionClass].join(" ")}
              style={{ insetL: r.x, insetT: r.y, width: r.w, height: r.h }}
            />
          ))}
          {lines().map((line, i) => {
            const pe = preedit();
            const text = displayDoc().slice(line.start, line.end);
            // preedit 下划线：覆盖 preedit 区间的行片段用 preeditClass
            const peStart = pe ? caret() : -1;
            const peEnd = pe ? caret() + pe.text.length : -1;
            const overlaps = pe && line.end > peStart && line.start < peEnd;
            return (
              <Text
                class={overlaps ? p.preeditClass : p.textClass}
                style={{ height: p.lineHeight }}
              >
                {text.length === 0 ? " " : text}
              </Text>
            );
          })}
          {focused() && blink() && !p.disabled ? (
            <View
              class={["absolute", p.caretClass].join(" ")}
              style={{
                insetL: caretPx(),
                insetT: caretRow() * p.lineHeight + 2,
                width: CARET_W,
                height: p.lineHeight - 4,
              }}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}
