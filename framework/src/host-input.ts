// 壳输入通道：与 companion 业务分渠的 host→guest 文本/键/指针协议。

import { virtualFrame } from "./clock.ts";
import { onFrame } from "./frame.ts";
import { getOps } from "./host.ts";
import { focusNode, getFocused, hitFocusable, moveFocusByTab } from "./input.ts";
import type { NodeMirror } from "./native-tree.ts";

/** 壳 → guest 的稳定输入事件（不含 companion 业务 JSON）。 */
export type HostInputEvent =
  | { t: "hello"; w: number; h: number; src?: "shell" }
  | { t: "resize"; w: number; h: number; src?: "shell" }
  | { t: "ch"; s: string; src?: "shell" }
  | { t: "key"; k: string; sh?: boolean; src?: "shell" }
  | { t: "paste"; text: string; src?: "shell" }
  | { t: "ime"; s: string; c?: number | null; src?: "shell" }
  | { t: "mouse"; x: number; y: number; d?: boolean; sh?: boolean; src?: "shell" }
  | { t: "scroll"; dy: number; src?: "shell" }
  | { t: "blur"; src?: "shell" }
  | { t: "load"; text: string; src?: "shell" }
  | { t: "companion_offline"; src?: "shell" };

const SHELL_TYPES = new Set([
  "hello",
  "resize",
  "ch",
  "key",
  "paste",
  "ime",
  "mouse",
  "scroll",
  "blur",
  "load",
  "companion_offline",
]);

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
  caretRect?: () => { x: number; y: number; h: number } | null;
};

const editableHandlers = new WeakMap<NodeMirror, EditableHandler>();
let installed = false;
let lastCaret = { x: -1, y: -1, h: -1 };
let prevMouseDown = false;

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

function isShellLine(raw: unknown): raw is HostInputEvent & { t: string } {
  if (!raw || typeof raw !== "object") return false;
  const ev = raw as { t?: unknown; src?: unknown };
  if (typeof ev.t !== "string" || !SHELL_TYPES.has(ev.t)) return false;
  if (ev.src === "companion") return false;
  if (ev.src === undefined || ev.src === "shell" || ev.src === "host") return true;
  return false;
}

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

function resolveInputChannel(fallbackName: string): HostChannel | null {
  return (
    openHostChannel("input") ??
    openHostChannel(fallbackName) ??
    openHostChannel("note")
  );
}

/**
 * 壳输入通道。优先打开 "input"；旧宿主仅有 app 名通道时回退。
 * poll() 只含壳事件。
 */
export function connectHostInput(fallbackName = "input"): {
  poll(): HostInputEvent[];
  send(
    line:
      | { t: "copy"; text: string }
      | { t: "cut"; text: string }
      | { t: "caret"; x: number; y: number; h: number }
      | { t: "ensure_text"; text: string }
      | { t: "quit" },
  ): void;
} | null {
  const channel = resolveInputChannel(fallbackName);
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

function dispatchToEditable(ev: HostInputEvent, handler: EditableHandler): void {
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
      handler.onIme?.(ev.s ?? "", ev.c === undefined ? null : ev.c);
      break;
    case "mouse":
      handler.onPointer?.(ev.x ?? -1, ev.y ?? -1, ev.d ?? false, ev.sh ?? false);
      break;
    case "scroll":
      handler.onScroll?.(ev.dy ?? 0);
      break;
    case "blur":
      handler.onBlur?.();
      break;
    default:
      break;
  }
}

/**
 * 安装框架级壳输入泵：按焦点投递文本/编辑键，Tab 遍历焦点。
 * 幂等；无 input 通道时 no-op。
 */
export function installHostInputPump(opts?: { channelName?: string }): () => void {
  if (installed) return () => {};
  const input = connectHostInput(opts?.channelName ?? "input");
  if (!input) return () => {};
  installed = true;

  onFrame(() => {
    const focused = getFocused();
    const handler = getEditableHandler(focused);
    for (const ev of input.poll()) {
      if (ev.t === "key" && ev.k === "Tab") {
        // 离开 editable 时先 blur
        if (handler) handler.onBlur?.();
        moveFocusByTab(ev.sh ? -1 : 1);
        continue;
      }
      if (handler) {
        // editable 吞文本/编辑键；mouse 也优先给字段做 caret
        dispatchToEditable(ev, handler);
        if (ev.t === "mouse") {
          const n = hitFocusable(ev.x ?? -1, ev.y ?? -1);
          if (n && n !== focused) {
            handler.onBlur?.();
            focusNode(n);
          }
          prevMouseDown = ev.d ?? false;
        }
      } else if (ev.t === "mouse") {
        const n = hitFocusable(ev.x ?? -1, ev.y ?? -1);
        if (n && n !== focused) focusNode(n);
        prevMouseDown = ev.d ?? false;
      }
      // 无 editable 时 ch/key 不投递（按钮焦点不吞文本）
    }

    const live = getEditableHandler(getFocused());
    if (live?.caretRect) {
      const rect = live.caretRect();
      if (
        rect &&
        (rect.x !== lastCaret.x || rect.y !== lastCaret.y || rect.h !== lastCaret.h)
      ) {
        lastCaret = rect;
        input.send({ t: "caret", ...rect });
      }
    }
  });

  return () => {
    installed = false;
  };
}

/** 请求宿主为任意运行时字符串扩展字形（text.glyphs.runtime）。 */
export function ensureText(text: string): void {
  if (!text) return;
  const channel = resolveInputChannel("input");
  channel?.send({ t: "ensure_text", text });
}

/** 测试：重置泵与缓冲。 */
export function __resetHostInputForTest(): void {
  installed = false;
  prevMouseDown = false;
  lastCaret = { x: -1, y: -1, h: -1 };
  rawBuffer = null;
}
