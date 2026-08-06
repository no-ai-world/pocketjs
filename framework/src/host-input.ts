// 壳输入通道：与 companion 业务分渠的 host→guest 文本/键/指针协议。

import { onCleanup } from "solid-js";
import { virtualFrame } from "./clock.ts";
import { onFramePersistent } from "./frame.ts";
import { getOps } from "./host.ts";
import {
  blurFocus,
  clearPointerHover,
  clearTextSelectionPointer,
  focusNode,
  getFocused,
  hitFocusable,
  hitNode,
  moveFocusByTab,
  onFocusChange,
  restoreFocus,
  setTextSelectionPointerDispatcher,
} from "./input.ts";
import {
  clearTextSelection as resetTextSelection,
  reconcileTextSelection,
} from "./text-selection.ts";
import { setTextContentReporter, type NodeMirror } from "./native-tree.ts";

/** 壳 → guest 的稳定输入事件（不含 companion 业务 JSON）。 */
type HostSource = "shell" | "host";

export type HostInputEvent =
  | { t: "hello"; w: number; h: number; src?: HostSource }
  | { t: "resize"; w: number; h: number; src?: HostSource }
  | { t: "ch"; s: string; src?: HostSource }
  | { t: "key"; k: string; sh?: boolean; src?: HostSource }
  | { t: "paste"; text: string; src?: HostSource }
  | { t: "ime"; s: string; c?: number | null; src?: HostSource }
  | {
      t: "mouse";
      x: number;
      y: number;
      d?: boolean;
      sh?: boolean;
      outside?: boolean;
      src?: HostSource;
    }
  | { t: "mouse_leave"; src?: HostSource }
  | { t: "scroll"; dy: number; src?: HostSource }
  | { t: "blur"; src?: HostSource }
  | { t: "focus"; src?: HostSource }
  | { t: "load"; text: string; src?: HostSource }
  | { t: "companion_offline"; src?: HostSource };

const SHELL_TYPES = new Set([
  "hello",
  "resize",
  "ch",
  "key",
  "paste",
  "ime",
  "mouse",
  "mouse_leave",
  "scroll",
  "blur",
  "focus",
  "load",
  "companion_offline",
]);

export type HostCaretRect = {
  /** Optional retained node that owns the local caret rectangle. */
  node?: number;
  x: number;
  y: number;
  h: number;
};

export type EditableHandler = {
  /** 字段是否接受编辑（disabled 时为 false）。 */
  active: () => boolean;
  onChars?: (text: string) => void;
  onKey?: (key: string, shift: boolean) => void;
  onPaste?: (text: string) => void;
  onIme?: (text: string, cursor: number | null) => void;
  onPointer?: (x: number, y: number, down: boolean, shift: boolean) => void;
  onScroll?: (dy: number) => void;
  onBlur?: () => void;
  /** 上报 caret 矩形（逻辑 px），宿主吸附 IME 候选窗。 */
  caretRect?: () => HostCaretRect | null;
};

export type CopyText = (text: string) => void;

export type SelectableHandler = {
  /** 文本是否接受选择输入。 */
  active: () => boolean;
  onKey?: (key: string, shift: boolean, copy: CopyText) => void;
  onPointer?: (x: number, y: number, down: boolean, shift: boolean) => void;
  onCancel?: () => void;
};

const editableHandlers = new WeakMap<NodeMirror, EditableHandler>();
const selectableHandlers = new WeakMap<NodeMirror, SelectableHandler>();
let selectableCapture: NodeMirror | null = null;
let selectableOwner: NodeMirror | null = null;
let selectableCount = 0;
let selectablePumpDisposer: (() => void) | null = null;
let manualHostInput = false;
let pumpUsers = 0;
let pumpChannelName: string | null = null;
let pumpChannel: { send(line: object | string): void } | null = null;
let pumpInput: NonNullable<ReturnType<typeof connectHostInput>> | null = null;
let pumpDisposer: (() => void) | null = null;
let lastCaret: HostCaretRect | null = null;
let mouseCapture: NodeMirror | null = null;
let pumpHostFocused = true;

/** 同帧共享 raw 行缓冲：宿主只有一条 svc 队列，按帧复用避免互排空。 */
let rawBuffer: { lines: string[]; frame: number } | null = null;
let lastPumpFrame = -1;

function drainRaw(): string[] {
  const ops = getOps();
  if (!ops.svcPoll) return [];
  const frame = virtualFrame();
  if (rawBuffer && rawBuffer.frame === frame) return rawBuffer.lines;
  const batch = ops.svcPoll();
  const lines = batch ? batch.split("\n").filter((line) => line !== "") : [];
  rawBuffer = { lines, frame };
  return lines;
}

/** 将节点登记为可编辑焦点目标。 */
export function registerEditable(node: NodeMirror, handler: EditableHandler | null): void {
  if (!handler) {
    editableHandlers.delete(node);
    return;
  }
  editableHandlers.set(node, handler);
}

export function getEditableHandler(node: NodeMirror | null): EditableHandler | null {
  if (!node) return null;
  return editableHandlers.get(node) ?? null;
}

export function registerSelectable(node: NodeMirror, handler: SelectableHandler | null): void {
  // 管理一个可选文字节点的输入注册。
  if (!handler) {
    const previous = selectableHandlers.get(node);
    previous?.onCancel?.();
    selectableHandlers.delete(node);
    selectableCount = Math.max(0, selectableCount - (previous ? 1 : 0));
    if (selectableCount === 0) {
      selectablePumpDisposer?.();
      selectablePumpDisposer = null;
    }
    if (selectableCapture === node) selectableCapture = null;
    if (selectableOwner === node) {
      selectableOwner = null;
      resetTextSelection();
    }
    return;
  }
  if (!selectableHandlers.has(node)) {
    selectableCount++;
    if (selectableCount === 1 && !manualHostInput) {
      selectablePumpDisposer = installHostInputPump({ bindCleanup: false });
    }
  }
  selectableHandlers.set(node, handler);
}

/** Clear the active all-text selection and its pointer ownership. */
export function clearSelectableTextSelection(): void {
  // 清除共享可选文字的输入状态。
  const owner = selectableCapture ?? selectableOwner;
  if (owner) selectableHandlers.get(owner)?.onCancel?.();
  selectableCapture = null;
  selectableOwner = null;
  resetTextSelection();
}

function hasEditableAncestor(node: NodeMirror): boolean {
  // 判断文字节点是否位于可编辑控件内。
  let current: NodeMirror | null = node;
  while (current) {
    if (current.focusKind === "editable" || editableHandlers.has(current)) return true;
    current = current.parent;
  }
  return false;
}

function selectableAt(x: number, y: number): NodeMirror | null {
  // 查找指针位置上的可选文字节点。
  let current = hitNode(x, y);
  while (current) {
    const handler = selectableHandlers.get(current);
    if (handler && handler.active() && !hasEditableAncestor(current)) return current;
    current = current.parent;
  }
  return null;
}

function dispatchToSelectable(
  ev: HostInputEvent,
  handler: SelectableHandler,
  capturedMouse = false,
): void {
  // 向可选文字节点分发输入事件。
  if (!handler.active()) return;
  switch (ev.t) {
    case "key":
      if (ev.k) handler.onKey?.(ev.k, ev.sh ?? false, sendClipboardText);
      break;
    case "mouse":
      handler.onPointer?.(ev.x, ev.y, ev.d ?? capturedMouse, ev.sh ?? false);
      break;
    default:
      break;
  }
}

function sendClipboardText(text: string): void {
  // 将选中文本发送到宿主剪贴板。
  if (!text) return;
  (pumpChannel ?? resolveInputChannel("input"))?.send({ t: "copy", text });
}

onFocusChange((previous, next) => {
  if (previous !== next) {
    if (mouseCapture && mouseCapture !== next) mouseCapture = null;
    if (next && selectableOwner) clearSelectableTextSelection();
    getEditableHandler(previous)?.onBlur?.();
  }
});

/** Identify object-shaped protocol records. */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === "object" && !Array.isArray(raw);
}

/** Validate finite numeric protocol fields. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate optional boolean protocol fields. */
function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

/** Validate one shell event against its discriminated payload shape. */
function isShellEvent(raw: Record<string, unknown>): raw is HostInputEvent {
  const type = raw.t;
  if (typeof type !== "string" || !SHELL_TYPES.has(type)) return false;
  if (raw.src !== undefined && raw.src !== "shell" && raw.src !== "host") return false;
  switch (type) {
    case "hello":
    case "resize":
      return isFiniteNumber(raw.w) && raw.w > 0 && isFiniteNumber(raw.h) && raw.h > 0;
    case "ch":
      return typeof raw.s === "string";
    case "key":
      return typeof raw.k === "string" && isOptionalBoolean(raw.sh);
    case "paste":
    case "load":
      return typeof raw.text === "string";
    case "ime": {
      const cursor = raw.c;
      return (
        typeof raw.s === "string" &&
        (cursor === undefined ||
          cursor === null ||
          (typeof cursor === "number" &&
            Number.isInteger(cursor) &&
            cursor >= 0 &&
            cursor <= raw.s.length))
      );
    }
    case "mouse":
      return isFiniteNumber(raw.x) && isFiniteNumber(raw.y) &&
        isOptionalBoolean(raw.d) &&
        isOptionalBoolean(raw.sh) &&
        isOptionalBoolean(raw.outside);
    case "scroll":
      return isFiniteNumber(raw.dy);
    case "mouse_leave":
    case "blur":
    case "focus":
    case "companion_offline":
      return true;
  }
  return false;
}

/** Admit only validated shell records from the shared queue. */
function isShellLine(raw: unknown): raw is HostInputEvent {
  return isRecord(raw) && isShellEvent(raw);
}

/** Keep companion business records out of the shell stream. */
function isCompanionLine(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return true;
  const ev = raw as { t?: unknown; src?: unknown };
  if (ev.src === "companion") return true;
  if (ev.src === "shell" || ev.src === "host") return false;
  if (typeof ev.t === "string" && SHELL_TYPES.has(ev.t)) return false;
  return true;
}

export interface HostChannel {
  /** 排空本帧宿主行（原始 JSON 字符串行，同帧可复用）。 */
  pollRaw(): string[];
  send(line: object | string): void;
  readonly name: string;
}

/** 打开命名 svc 通道；失败返回 null（无宿主 / 未 tether）。 */
export function openHostChannel(name: string): HostChannel | null {
  const ops = getOps();
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend || !ops.svcOpen(name)) return null;
  const send = ops.svcSend.bind(ops);
  return {
    name,
    pollRaw() {
      return drainRaw();
    },
    send(line) {
      send(typeof line === "string" ? line : JSON.stringify(line));
    },
  };
}

function parseLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // 畸形行跳过，避免卡死 reduce
    }
  }
  return out;
}

/** Resolve the requested channel before compatibility fallbacks. */
function resolveInputChannel(channelName: string): HostChannel | null {
  const names = channelName === "input"
    ? ["input", "note"]
    : [channelName, "input", "note"];
  for (const name of names) {
    const channel = openHostChannel(name);
    if (channel) return channel;
  }
  return null;
}

/**
 * 壳输入通道。优先打开 "input"；旧宿主仅有 app 名通道时回退。
 * poll() 只含壳事件。
 */
export function connectHostInput(channelName = "input"): {
  poll(): HostInputEvent[];
  send(
    line:
      | { t: "copy"; text: string }
      | { t: "cut"; text: string }
      | { t: "caret"; node?: number; x: number; y: number; h: number }
      | { t: "caret_clear" }
      | { t: "ensure_text"; text: string }
      | { t: "quit" },
  ): void;
} | null {
  const channel = resolveInputChannel(channelName);
  if (!channel) return null;
  return {
    poll() {
      const events: HostInputEvent[] = [];
      for (const raw of parseLines(channel.pollRaw())) {
        if (isShellLine(raw)) events.push(raw as HostInputEvent);
      }
      return events;
    },
    send(line) {
      channel.send(line);
    },
  };
}

/**
 * Companion 业务通道。只返回非壳事件，避免 scroll/ch 混入业务 reduce。
 * 与 connectHostInput 共享同帧 raw 缓冲。
 */
export function connectCompanion(channelName = "input"): {
  poll(): unknown[];
  send(line: object | string): void;
} | null {
  const channel =
    openHostChannel(channelName) ??
    openHostChannel("companion") ??
    openHostChannel("input");
  if (!channel) return null;
  return {
    poll() {
      return parseLines(channel.pollRaw()).filter(isCompanionLine);
    },
    send(line) {
      channel.send(line);
    },
  };
}

/** 兼容旧 note svc 名；包含 load 等 note 专用壳事件。 */
export function connectNoteHost(): {
  poll(): HostInputEvent[];
  send(line: object): void;
} | null {
  const channel = openHostChannel("note") ?? openHostChannel("input");
  if (!channel) return null;
  const selectablePump = selectablePumpDisposer;
  selectablePumpDisposer = null;
  selectablePump?.();
  clearSelectableTextSelection();
  manualHostInput = true;
  return {
    poll() {
      const events: HostInputEvent[] = [];
      for (const raw of parseLines(channel.pollRaw())) {
        if (isShellLine(raw)) events.push(raw as HostInputEvent);
      }
      return events;
    },
    send(line) {
      channel.send(line);
    },
  };
}

function dispatchToEditable(
  ev: HostInputEvent,
  handler: EditableHandler,
  capturedMouse = false,
): void {
  if (!handler.active()) return;
  switch (ev.t) {
    case "ch":
      if (ev.s) handler.onChars?.(ev.s);
      break;
    case "key":
      if (ev.k) handler.onKey?.(ev.k, ev.sh ?? false);
      break;
    case "paste":
      if (ev.text) handler.onPaste?.(ev.text);
      break;
    case "ime":
      handler.onIme?.(ev.s, ev.c === undefined ? null : ev.c);
      break;
    case "mouse":
      handler.onPointer?.(ev.x, ev.y, ev.d ?? capturedMouse, ev.sh ?? false);
      break;
    case "scroll":
      handler.onScroll?.(ev.dy);
      break;
    default:
      break;
  }
}

function dispatchSelectablePointer(x: number, y: number, down: boolean): boolean {
  // 路由一帧指针接触到可选文字节点。
  if (manualHostInput) return false;
  if (!down) {
    if (!selectableCapture) return false;
    const capture = selectableCapture;
    selectableCapture = null;
    const handler = selectableHandlers.get(capture);
    if (handler) dispatchToSelectable({ t: "mouse", x, y, d: false }, handler, true);
    return true;
  }

  const selectable = selectableCapture ?? selectableAt(x, y);
  if (!selectable) return false;
  if (!selectableCapture) {
    if (selectableOwner !== selectable) clearSelectableTextSelection();
    mouseCapture = null;
    const hit = hitFocusable(x, y);
    if (hit !== getFocused()) focusNode(hit);
    selectableCapture = selectable;
    selectableOwner = selectable;
  }
  const handler = selectableHandlers.get(selectable);
  if (handler) dispatchToSelectable({ t: "mouse", x, y, d: true }, handler, true);
  return true;
}

function cancelSelectablePointer(): void {
  // 清除可选文字的指针捕获。
  const capture = selectableCapture;
  selectableCapture = null;
  if (capture) selectableHandlers.get(capture)?.onCancel?.();
  clearTextSelectionPointer();
}

setTextSelectionPointerDispatcher(
  dispatchSelectablePointer,
  cancelSelectablePointer,
  () => selectableCapture !== null,
  clearSelectableTextSelection,
);

/** Route mouse events with text selection before editable capture. */
function dispatchMouseEvent(
  ev: Extract<HostInputEvent, { t: "mouse" }>,
): void {
  if (ev.outside && ev.d === false) {
    if (dispatchSelectablePointer(ev.x, ev.y, false)) {
      focusNode(null);
      return;
    }
    if (mouseCapture) {
      const handler = getEditableHandler(mouseCapture);
      if (handler) dispatchToEditable(ev, handler);
      mouseCapture = null;
    } else {
      // Cancel an action owner when its release happened outside the window.
      focusNode(null);
    }
    return;
  }

  if (selectableCapture) {
    dispatchSelectablePointer(ev.x, ev.y, ev.d !== false);
    return;
  }

  if (ev.d === true && dispatchSelectablePointer(ev.x, ev.y, true)) return;

  if (ev.d === true) {
    clearSelectableTextSelection();
    if (!mouseCapture) {
      const hit = hitFocusable(ev.x, ev.y);
      if (!hit) {
        focusNode(null);
        return;
      }
      if (hit !== getFocused()) focusNode(hit);
      mouseCapture = getEditableHandler(hit) ? hit : null;
    }
    const handler = getEditableHandler(mouseCapture ?? getFocused());
    if (handler) dispatchToEditable(ev, handler);
    return;
  }

  if (ev.d === false && mouseCapture) {
    const handler = getEditableHandler(mouseCapture);
    if (handler) dispatchToEditable(ev, handler);
    mouseCapture = null;
    return;
  }

  if (ev.d === undefined && mouseCapture) {
    const handler = getEditableHandler(mouseCapture);
    if (handler) dispatchToEditable(ev, handler, true);
    return;
  }

  const hit = hitFocusable(ev.x, ev.y);
  // Hover never focuses editable controls; click handling above owns that transition.
  if (hit?.focusKind !== "editable") {
    if (hit && hit !== getFocused()) focusNode(hit);
    else if (!hit) focusNode(null);
  }
  const handler = hit === getFocused() ? getEditableHandler(hit) : null;
  if (handler) dispatchToEditable(ev, handler);
}

/** Run one host-input turn for the active framework frame loop. */
export function runHostInputPump(): void {
  // 运行当前框架的一轮宿主输入分发。
  if (manualHostInput) return;
  const input = pumpInput;
  if (!input) {
    reconcileTextSelection();
    return;
  }
  const frame = virtualFrame();
  if (lastPumpFrame === frame) return;
  lastPumpFrame = frame;
  reconcileTextSelection();
  for (const ev of input.poll()) {
    if (ev.t === "blur") {
      // Blur is a shell lifecycle event, not an editable event. It must
      // clear action focus and pointer capture even when no editable
      // handler is currently active.
      pumpHostFocused = false;
      clearSelectableTextSelection();
      mouseCapture = null;
      blurFocus();
      continue;
    }
    if (ev.t === "focus") {
      pumpHostFocused = true;
      restoreFocus();
      continue;
    }
    // Drop queued interactive events until the shell restores focus.
    if (!pumpHostFocused && (
      ev.t === "ch" || ev.t === "key" || ev.t === "paste" || ev.t === "ime" ||
      ev.t === "mouse" || ev.t === "mouse_leave" || ev.t === "scroll"
    )) continue;
    const focused = getFocused();
    const handler = getEditableHandler(focused);
    if (ev.t === "key" && ev.k === "Tab") {
      clearSelectableTextSelection();
      moveFocusByTab(ev.sh ? -1 : 1);
      continue;
    }
    if (ev.t === "mouse_leave") {
      // A leave clears hover without canceling a native pointer owner or
      // an active editable drag; release/blur owns cancellation.
      if (!mouseCapture) clearPointerHover();
      continue;
    }
    if (ev.t === "mouse") {
      dispatchMouseEvent(ev);
      continue;
    }
    if (handler) dispatchToEditable(ev, handler);
    else if (ev.t === "key" && selectableOwner) {
      const selectable = selectableHandlers.get(selectableOwner);
      if (selectable) dispatchToSelectable(ev, selectable);
      else selectableOwner = null;
    }
    // 无 editable 时 ch/key 不投递（按钮焦点不吞文本）
  }

  const live = pumpHostFocused ? getEditableHandler(getFocused()) : undefined;
  const rect = live?.caretRect?.() ?? null;
  if (
    rect &&
    (!lastCaret ||
      rect.node !== lastCaret.node ||
      rect.x !== lastCaret.x ||
      rect.y !== lastCaret.y ||
      rect.h !== lastCaret.h)
  ) {
    lastCaret = rect;
    input.send({ t: "caret", ...rect });
  } else if (!rect && lastCaret) {
    lastCaret = null;
    input.send({ t: "caret_clear" });
  }
}

/**
 * 安装框架级壳输入泵：按焦点投递文本/编辑键，Tab 遍历焦点。
 * 引用计数；无 input 通道时 no-op。
 */
export function installHostInputPump(opts?: { channelName?: string; bindCleanup?: boolean }): () => void {
  // 管理宿主输入泵的共享生命周期。
  const channelName = opts?.channelName ?? "input";
  if (pumpUsers > 0 && pumpChannelName !== channelName) {
    throw new Error(
      `host input pump already uses '${pumpChannelName}'; cannot switch to '${channelName}'`,
    );
  }
  const input = connectHostInput(channelName);
  if (!input) return () => {};
  pumpUsers++;
  pumpChannelName ??= channelName;
  flushTextGlyphs(channelName); // 通道就绪，补发模板解析期积压的字形

  if (!pumpDisposer) {
    pumpChannel = input;
    pumpInput = input;
    pumpDisposer = onFramePersistent(runHostInputPump);
  }

  let disposed = false;
  const dispose = () => {
    // 释放一个宿主输入泵引用。
    if (disposed) return;
    disposed = true;
    pumpUsers = Math.max(0, pumpUsers - 1);
    if (pumpUsers !== 0) return;
    pumpChannel?.send({ t: "caret_clear" });
    pumpDisposer?.();
    pumpDisposer = null;
    pumpChannelName = null;
    pumpChannel = null;
    pumpInput = null;
    lastCaret = null;
    rawBuffer = null;
    lastPumpFrame = -1;
    mouseCapture = null;
    clearSelectableTextSelection();
    manualHostInput = false;
    pumpHostFocused = true;
  };
  if (opts?.bindCleanup !== false) onCleanup(dispose);
  return dispose;
}

/** 请求宿主为任意运行时字符串扩展字形（text.glyphs.runtime）。 */
/** 请求宿主为任意运行时字符串扩展字形（text.glyphs.runtime）。 */
export function ensureText(text: string): void {
  if (!text) return;
  const channel = resolveInputChannel("input");
  if (!channel) return;
  // 显式请求视为已确认，渲染路径不再重复上报同一码点。
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x7f) reportedGlyphCodepoints.add(cp);
  }
  channel.send({ t: "ensure_text", text });
}

/** 已确认送达宿主的非 ASCII 码点：宿主按 slot known 集合幂等，重复码点无需再发。 */
const reportedGlyphCodepoints = new Set<number>();
/** 宿主通道暂不可用（svcOpen 失败）时积压的码点，通道恢复后补发。 */
const pendingGlyphCodepoints = new Set<number>();

function flushPendingGlyphs(channelName: string): void {
  if (pendingGlyphCodepoints.size === 0) return;
  const channel = resolveInputChannel(channelName);
  if (!channel) return;
  let missing = "";
  for (const cp of pendingGlyphCodepoints) {
    missing += String.fromCodePoint(cp);
    reportedGlyphCodepoints.add(cp);
  }
  pendingGlyphCodepoints.clear();
  channel.send({ t: "ensure_text", text: missing });
}

function reportRenderedText(text: string): void {
  // 渲染文本只上报非 ASCII 码点（CJK 等）；通道不可用时先积压，恢复后补发，
  // 只有确认通道可用才记为“已上报”——避免模板/热更时序下丢字形。
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) continue;
    if (reportedGlyphCodepoints.has(cp) || pendingGlyphCodepoints.has(cp)) continue;
    pendingGlyphCodepoints.add(cp);
  }
  flushPendingGlyphs(pumpChannelName ?? "input");
}

// 渲染文本进树即上报；无 svc 宿主（PSP 等）的 ensureText 本身是 no-op。
setTextContentReporter(reportRenderedText);

/** 宿主通道就绪时补发积压字形（pump 安装后调用；幂等，pending 空时零开销）。 */
export function flushTextGlyphs(channelName = "input"): void {
  flushPendingGlyphs(channelName);
}

/** 测试：重置已上报/积压码点集合并恢复上报钩子。 */
export function __resetTextGlyphReporterForTest(): void {
  reportedGlyphCodepoints.clear();
  pendingGlyphCodepoints.clear();
  setTextContentReporter(reportRenderedText);
}

/** Reset local input state shared between mounts. */
function clearLocalHostInputState(): void {
  // Drop buffered rows, pointer capture, and the cached IME rectangle together.
  rawBuffer = null;
  lastPumpFrame = -1;
  mouseCapture = null;
  clearSelectableTextSelection();
  manualHostInput = false;
  lastCaret = null;
  pumpHostFocused = true;
}

/** 清除宿主输入状态，避免跨 mount 复用旧 svc 行或 pointer capture。 */
export function resetHostInputBuffer(): void {
  // Clear the native IME anchor on the channel currently driving the pump.
  (pumpChannel ?? resolveInputChannel("input"))?.send({ t: "caret_clear" });
  clearLocalHostInputState();
}

/** 测试：重置泵与缓冲。 */
export function __resetHostInputForTest(): void {
  pumpDisposer?.();
  pumpDisposer = null;
  pumpUsers = 0;
  pumpChannelName = null;
  pumpChannel = null;
  pumpInput = null;
  clearLocalHostInputState();
}
