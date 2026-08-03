// 壳输入通道：与 companion 业务分渠的 host→guest 文本/键/指针协议。

import { onCleanup } from "solid-js";
import { virtualFrame } from "./clock.ts";
import { onFramePersistent } from "./frame.ts";
import { getOps } from "./host.ts";
import {
  blurFocus,
  clearPointerHover,
  focusNode,
  getFocused,
  hitFocusable,
  moveFocusByTab,
  onFocusChange,
  restoreFocus,
} from "./input.ts";
import type { NodeMirror } from "./native-tree.ts";

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

const editableHandlers = new WeakMap<NodeMirror, EditableHandler>();
let pumpUsers = 0;
let pumpChannelName: string | null = null;
let pumpChannel: { send(line: object | string): void } | null = null;
let pumpDisposer: (() => void) | null = null;
let lastCaret: HostCaretRect | null = null;
let mouseCapture: NodeMirror | null = null;
let pumpHostFocused = true;

/** 同帧共享 raw 行缓冲：宿主只有一条 svc 队列，按帧复用避免互排空。 */
let rawBuffer: { lines: string[]; frame: number } | null = null;

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

onFocusChange((previous, next) => {
  if (previous !== next) {
    if (mouseCapture && mouseCapture !== next) mouseCapture = null;
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

/** Route mouse events with blank-click blur and editable drag capture. */
function dispatchMouseEvent(
  ev: Extract<HostInputEvent, { t: "mouse" }>,
): void {
  if (ev.outside && ev.d === false) {
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
  const hit = hitFocusable(ev.x, ev.y);
  if (ev.d === true) {
    if (!mouseCapture) {
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

  // Hover never focuses editable controls; click handling above owns that transition.
  if (hit?.focusKind !== "editable") {
    if (hit && hit !== getFocused()) focusNode(hit);
    else if (!hit) focusNode(null);
  }
  const handler = hit === getFocused() ? getEditableHandler(hit) : null;
  if (handler) dispatchToEditable(ev, handler);
}

/**
 * 安装框架级壳输入泵：按焦点投递文本/编辑键，Tab 遍历焦点。
 * 引用计数；无 input 通道时 no-op。
 */
export function installHostInputPump(opts?: { channelName?: string }): () => void {
  // Keep one frame pump alive until every caller releases its registration.
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

  if (!pumpDisposer) {
    pumpChannel = input;
    pumpDisposer = onFramePersistent(() => {
      for (const ev of input.poll()) {
        if (ev.t === "blur") {
          // Blur is a shell lifecycle event, not an editable event. It must
          // clear action focus and pointer capture even when no editable
          // handler is currently active.
          pumpHostFocused = false;
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
    });
  }

  let disposed = false;
  const dispose = () => {
    // Release this caller without tearing down other input users.
    if (disposed) return;
    disposed = true;
    pumpUsers = Math.max(0, pumpUsers - 1);
    if (pumpUsers !== 0) return;
    pumpChannel?.send({ t: "caret_clear" });
    pumpDisposer?.();
    pumpDisposer = null;
    pumpChannelName = null;
    pumpChannel = null;
    lastCaret = null;
    rawBuffer = null;
    mouseCapture = null;
    pumpHostFocused = true;
  };
  onCleanup(dispose);
  return dispose;
}

/** 请求宿主为任意运行时字符串扩展字形（text.glyphs.runtime）。 */
export function ensureText(text: string): void {
  if (!text) return;
  const channel = resolveInputChannel("input");
  channel?.send({ t: "ensure_text", text });
}

/** Reset local input state shared between mounts. */
function clearLocalHostInputState(): void {
  // Drop buffered rows, pointer capture, and the cached IME rectangle together.
  rawBuffer = null;
  mouseCapture = null;
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
  clearLocalHostInputState();
}
