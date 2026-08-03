// 框架 text-edit 纯数学 + host-input 分渠

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  backspaceSel,
  caretFromX,
  caretLine,
  deleteSel,
  emptyHistory,
  hasSelection,
  layoutDoc,
  recordEdit,
  redo,
  selBounds,
  typeText,
  undo,
} from "../framework/src/text-edit.ts";
import {
  __resetHostInputForTest,
  connectCompanion,
  connectHostInput,
  installHostInputPump,
  openHostChannel,
  registerEditable,
  resetHostInputBuffer,
} from "../framework/src/host-input.ts";
import {
  focusNode,
  getFocused,
  registerFocusable,
  setHitRoot,
  setInputRoot,
} from "../framework/src/input.ts";
import type { NodeMirror } from "../framework/src/native-tree.ts";
import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import { __advanceClock, resetClock } from "../framework/src/clock.ts";
import { resetFrameHooks, runFrameHooks } from "../framework/src/frame.ts";

const M = (t: string) => t.length * 10;

describe("text-edit layout/selection", () => {
  test("soft wrap and caret line", () => {
    const doc = "alpha beta gamma";
    const lines = layoutDoc(doc, 100, M);
    expect(lines).toHaveLength(2);
    expect(caretLine(lines, 6)).toBe(1);
    expect(caretFromX(doc, lines, 0, 999, M)).toBe(5);
  });

  test("selection replace and history", () => {
    const s0 = { doc: "hello world", caret: 11, anchor: 6 };
    expect(selBounds(s0)).toEqual([6, 11]);
    const s1 = typeText(s0, "there");
    expect(s1.doc).toBe("hello there");
    expect(hasSelection(s1)).toBe(false);
    expect(backspaceSel({ doc: "ab", caret: 1, anchor: 1 }).doc).toBe("b");
    expect(deleteSel({ doc: "ab", caret: 1, anchor: 1 }).doc).toBe("a");

    const h = emptyHistory();
    let cur = { doc: "a", caret: 1, anchor: 1 };
    recordEdit(h, cur, "other");
    cur = { doc: "ab", caret: 2, anchor: 2 };
    const back = undo(h, cur)!;
    expect(back.doc).toBe("a");
    expect(redo(h, back)!.doc).toBe("ab");
  });
});

describe("host-input shell/companion split", () => {
  let inbox: string[];
  let outbox: string[];
  let polls = 0;
  let hitId = 0;

  function mountMock(lines: string[], channels = ["input", "note"]) {
    inbox = [...lines];
    outbox = [];
    polls = 0;
    hitId = 0;
    const ops = {
      createNode: () => 1,
      destroyNode: () => {},
      insertBefore: () => {},
      removeChild: () => {},
      setStyle: () => {},
      setProp: () => {},
      setText: () => {},
      replaceText: () => {},
      uploadTexture: () => 0,
      setImage: () => {},
      setSprite: () => {},
      animate: () => 0,
      cancelAnim: () => {},
      setFocus: () => {},
      measureText: () => 0,
      svcOpen: (name: string) => channels.includes(name),
      svcPoll: () => {
        polls++;
        if (inbox.length === 0) return undefined;
        const batch = inbox.join("\n") + "\n";
        inbox.length = 0;
        return batch;
      },
      svcSend: (line: string) => {
        outbox.push(line);
      },
      hitTest: () => hitId,
      __host: "windows-widget",
      __hostAbi: 3,
    } as HostOps;
    installHost({ kind: "injected", ops } as Host);
  }

  beforeEach(() => {
    __resetHostInputForTest();
    resetClock();
    resetFrameHooks();
  });

  afterEach(() => {
    focusNode(null);
    setHitRoot(null);
    setInputRoot(null);
    __resetHostInputForTest();
    resetFrameHooks();
  });

  test("pollInput drops companion rows; pollCompanion drops shell rows", () => {
    mountMock([
      JSON.stringify({ t: "ch", s: "a", src: "shell" }),
      JSON.stringify({ t: "hello", protocol: "bililive", host: "x", src: "companion" }),
      JSON.stringify({ t: "scroll", dy: 12 }),
      JSON.stringify({ t: "status", text: "ok", src: "companion" }),
    ]);
    __advanceClock();
    const input = connectHostInput()!;
    const companion = connectCompanion()!;
    const shell = input.poll();
    const biz = companion.poll();
    expect(shell.map((e) => e.t).sort()).toEqual(["ch", "scroll"]);
    expect(biz).toHaveLength(2);
    expect((biz[0] as { t: string }).t).toBe("hello");
    expect((biz[1] as { t: string }).t).toBe("status");
  });

  test("same-frame raw buffer is shared (no double drain)", () => {
    mountMock([JSON.stringify({ t: "ch", s: "z", src: "shell" })]);
    __advanceClock();
    const a = connectHostInput()!;
    const b = connectHostInput()!;
    expect(a.poll()).toHaveLength(1);
    expect(b.poll()).toHaveLength(1); // 同帧复用
    __advanceClock();
    expect(a.poll()).toHaveLength(0);
  });

  test("mount reset discards buffered rows from the previous host", () => {
    mountMock([JSON.stringify({ t: "ch", s: "old", src: "shell" })]);
    __advanceClock();
    expect(connectHostInput()!.poll()[0]).toMatchObject({ s: "old" });

    mountMock([JSON.stringify({ t: "ch", s: "new", src: "shell" })]);
    resetHostInputBuffer();
    expect(connectHostInput()!.poll()[0]).toMatchObject({ s: "new" });
  });

  test("reset clears the native caret anchor before remount", () => {
    mountMock([]);
    const node = { id: 9 } as NodeMirror;
    registerEditable(node, {
      active: () => getFocused() === node,
      caretRect: () => ({ x: 4, y: 5, h: 16 }),
    });
    focusNode(node);
    const dispose = installHostInputPump();
    __advanceClock();
    runFrameHooks(0);
    expect(outbox).toContain(JSON.stringify({ t: "caret", x: 4, y: 5, h: 16 }));

    resetHostInputBuffer();
    expect(outbox.at(-1)).toBe(JSON.stringify({ t: "caret_clear" }));
    __advanceClock();
    runFrameHooks(0);
    expect(outbox.at(-1)).toBe(JSON.stringify({ t: "caret", x: 4, y: 5, h: 16 }));
    dispose();
    registerEditable(node, null);
  });

  test("negative caret coordinates still clear the native anchor", () => {
    mountMock([]);
    const node = { id: 12 } as NodeMirror;
    registerEditable(node, {
      active: () => getFocused() === node,
      caretRect: () => ({ x: -1, y: 5, h: 16 }),
    });
    focusNode(node);
    const dispose = installHostInputPump();
    __advanceClock();
    runFrameHooks(0);
    expect(outbox.at(-1)).toBe(JSON.stringify({ t: "caret", x: -1, y: 5, h: 16 }));
    registerEditable(node, null);
    __advanceClock();
    runFrameHooks(0);
    expect(outbox.at(-1)).toBe(JSON.stringify({ t: "caret_clear" }));
    dispose();
    focusNode(null);
  });

  test("caret owner changes are not hidden by an unchanged local rectangle", () => {
    mountMock([]);
    const node = { id: 11 } as NodeMirror;
    let owner = 21;
    registerEditable(node, {
      active: () => getFocused() === node,
      caretRect: () => ({ node: owner, x: 4, y: 5, h: 16 }),
    });
    focusNode(node);
    const dispose = installHostInputPump();
    __advanceClock();
    runFrameHooks(0);
    expect(outbox.at(-1)).toBe(JSON.stringify({ t: "caret", node: 21, x: 4, y: 5, h: 16 }));
    owner = 22;
    __advanceClock();
    runFrameHooks(0);
    expect(outbox.at(-1)).toBe(JSON.stringify({ t: "caret", node: 22, x: 4, y: 5, h: 16 }));
    dispose();
    registerEditable(node, null);
  });

  test("custom pump channel receives caret reset and dispose clears it", () => {
    mountMock([], ["custom"]);
    const node = { id: 10 } as NodeMirror;
    registerEditable(node, {
      active: () => getFocused() === node,
      caretRect: () => ({ x: 4, y: 5, h: 16 }),
    });
    focusNode(node);
    const dispose = installHostInputPump({ channelName: "custom" });
    __advanceClock();
    runFrameHooks(0);
    resetHostInputBuffer();
    expect(outbox.at(-1)).toBe(JSON.stringify({ t: "caret_clear" }));
    __advanceClock();
    runFrameHooks(0);
    dispose();
    expect(outbox.at(-1)).toBe(JSON.stringify({ t: "caret_clear" }));
    registerEditable(node, null);
  });

  test("input pump survives a frame-hook reset and can remount", () => {
    mountMock([]);
    const first = installHostInputPump();
    resetFrameHooks();
    inbox.push(JSON.stringify({ t: "hello", w: 480, h: 320, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(polls).toBe(1);
    first();

    const second = installHostInputPump();
    inbox.push(JSON.stringify({ t: "hello", w: 640, h: 360, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(polls).toBe(2);
    second();
  });

  test("focus lifecycle events stay in the shell stream", () => {
    mountMock([JSON.stringify({ t: "focus", src: "shell" })]);
    __advanceClock();
    expect(connectHostInput()!.poll()).toEqual([{ t: "focus", src: "shell" }]);
  });

  test("blur clears framework focus before later input", () => {
    mountMock([JSON.stringify({ t: "blur", src: "shell" })]);
    const node = { id: 7 } as NodeMirror;
    let blurred = false;
    registerEditable(node, {
      active: () => getFocused() === node,
      onBlur: () => {
        blurred = true;
      },
    });
    focusNode(node);
    const dispose = installHostInputPump();
    __advanceClock();
    runFrameHooks(0);
    expect(blurred).toBe(true);
    expect(getFocused()).toBeNull();
    dispose();
    registerEditable(node, null);
  });

  test("blur drops queued interactive events until focus restores", () => {
    mountMock([
      JSON.stringify({ t: "blur", src: "shell" }),
      JSON.stringify({ t: "mouse", x: 10, y: 10, d: true, src: "shell" }),
      JSON.stringify({ t: "key", k: "Tab", src: "shell" }),
    ]);
    const root = { id: 1, type: 0, parent: null, children: [] } as NodeMirror;
    const node = { id: 7, type: 0, parent: root, children: [] } as NodeMirror;
    root.children.push(node);
    setInputRoot(root);
    setHitRoot(root);
    registerFocusable(node, true);
    hitId = node.id;
    const dispose = installHostInputPump();
    focusNode(node);
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();
    dispose();
  });

  test("blur clears action focus and stale editable capture", () => {
    mountMock([]);
    const root = { id: 1, type: 0, parent: null, children: [] } as NodeMirror;
    const oldNode = { id: 7, type: 0, parent: root, children: [] } as NodeMirror;
    const newNode = { id: 8, type: 0, parent: root, children: [] } as NodeMirror;
    root.children.push(oldNode, newNode);
    setInputRoot(root);
    setHitRoot(root);
    registerFocusable(oldNode, true);
    registerFocusable(newNode, true);
    let newPresses = 0;
    registerEditable(oldNode, {
      active: () => getFocused() === oldNode,
      onPointer: () => {},
    });
    registerEditable(newNode, {
      active: () => getFocused() === newNode,
      onPointer: () => {
        newPresses++;
      },
    });
    const dispose = installHostInputPump();
    focusNode(oldNode);
    hitId = oldNode.id;
    inbox.push(JSON.stringify({ t: "mouse", x: 10, y: 10, d: true, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    inbox.push(JSON.stringify({ t: "blur", src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();

    inbox.push(JSON.stringify({ t: "focus", src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBe(oldNode);

    hitId = newNode.id;
    inbox.push(JSON.stringify({ t: "mouse", x: 20, y: 20, d: true, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBe(newNode);
    expect(newPresses).toBe(1);
    dispose();
    registerEditable(oldNode, null);
    registerEditable(newNode, null);
  });

  test("blur handles a focused action without an editable handler", () => {
    mountMock([JSON.stringify({ t: "blur", src: "shell" })]);
    const node = { id: 11 } as NodeMirror;
    registerFocusable(node, true);
    focusNode(node);
    const dispose = installHostInputPump();
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();
    dispose();
  });

  test("rejects malformed shell payloads before dispatch", () => {
    mountMock([
      JSON.stringify({ t: "ch", s: 123, src: "shell" }),
      JSON.stringify({ t: "mouse", x: "bad", y: 10, d: true, src: "shell" }),
    ]);
    __advanceClock();
    expect(connectHostInput()!.poll()).toHaveLength(0);
  });

  test("blank mouse-down blurs and captured drag reaches the editable", () => {
    mountMock([]);
    const root = { id: 1, type: 0, parent: null, children: [] } as NodeMirror;
    const node = { id: 7, type: 0, parent: root, children: [] } as NodeMirror;
    root.children.push(node);
    setInputRoot(root);
    setHitRoot(root);
    registerFocusable(node, true);
    const pointers: Array<[number, number, boolean]> = [];
    registerEditable(node, {
      active: () => getFocused() === node,
      onPointer: (x, y, down) => pointers.push([x, y, down]),
    });
    const dispose = installHostInputPump();
    focusNode(node);
    inbox.push(JSON.stringify({ t: "mouse", x: 20, y: 20, d: true, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();

    hitId = node.id;
    focusNode(node);
    inbox.push(JSON.stringify({ t: "mouse", x: 10, y: 10, d: true, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    hitId = 0;
    inbox.push(JSON.stringify({ t: "mouse", x: 500, y: 10, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    inbox.push(JSON.stringify({ t: "mouse", x: 500, y: 10, d: false, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(pointers).toEqual([
      [10, 10, true],
      [500, 10, true],
      [500, 10, false],
    ]);
    dispose();
    registerEditable(node, null);
  });

  test("mouse hover does not focus editable controls and preserves click capture", () => {
    mountMock([]);
    const root = { id: 1, type: 0, parent: null, children: [] } as NodeMirror;
    const node = {
      id: 7,
      type: 0,
      parent: root,
      children: [],
      focusKind: "editable" as const,
    } as NodeMirror;
    const action = {
      id: 8,
      type: 0,
      parent: root,
      children: [],
      focusKind: "action" as const,
    } as NodeMirror;
    root.children.push(node, action);
    setInputRoot(root);
    setHitRoot(root);
    registerFocusable(node, true);
    registerFocusable(action, true);
    const pointers: boolean[] = [];
    registerEditable(node, {
      active: () => getFocused() === node,
      onPointer: (_x, _y, down) => pointers.push(down),
    });
    const dispose = installHostInputPump();

    hitId = node.id;
    inbox.push(JSON.stringify({ t: "mouse", x: 10, y: 10, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();

    hitId = 0;
    inbox.push(JSON.stringify({ t: "mouse_leave", src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();

    hitId = node.id;
    inbox.push(JSON.stringify({ t: "mouse", x: 10, y: 10, d: true, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    hitId = 0;
    inbox.push(JSON.stringify({ t: "mouse_leave", src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBe(node);

    inbox.push(JSON.stringify({ t: "mouse", x: 500, y: 10, d: false, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(pointers).toEqual([true, false]);

    hitId = action.id;
    inbox.push(JSON.stringify({ t: "mouse", x: 20, y: 10, d: false, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBe(action);
    expect(pointers).toEqual([true, false]);

    hitId = 0;
    inbox.push(JSON.stringify({ t: "mouse", x: 500, y: 10, d: false, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();
    dispose();
    registerEditable(node, null);
  });

  test("outside release clears action focus even without mouse_leave", () => {
    mountMock([]);
    const root = { id: 1, type: 0, parent: null, children: [] } as NodeMirror;
    const node = { id: 7, type: 0, parent: root, children: [] } as NodeMirror;
    root.children.push(node);
    setInputRoot(root);
    setHitRoot(root);
    registerFocusable(node, true);
    const dispose = installHostInputPump();
    focusNode(node);
    inbox.push(
      JSON.stringify({
        t: "mouse",
        x: 10,
        y: 10,
        d: false,
        outside: true,
        src: "shell",
      }),
    );
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();
    dispose();
  });

  test("background mouse movement clears hover focus without capture", () => {
    mountMock([]);
    const root = { id: 1, type: 0, parent: null, children: [] } as NodeMirror;
    const node = { id: 7, type: 0, parent: root, children: [] } as NodeMirror;
    root.children.push(node);
    setInputRoot(root);
    setHitRoot(root);
    registerFocusable(node, true);
    const dispose = installHostInputPump();
    focusNode(node);
    hitId = 0;
    inbox.push(JSON.stringify({ t: "mouse", x: 500, y: 10, src: "shell" }));
    __advanceClock();
    runFrameHooks(0);
    expect(getFocused()).toBeNull();
    dispose();
    registerFocusable(node, false);
  });

  test("rejects switching a shared pump to another channel", () => {
    mountMock([]);
    const first = installHostInputPump();
    expect(() => installHostInputPump({ channelName: "note" })).toThrow(
      "already uses 'input'",
    );
    first();
  });

  test("focus transitions synchronously notify the old editable", () => {
    mountMock([]);
    const node = { id: 8 } as NodeMirror;
    let blurred = 0;
    registerEditable(node, {
      active: () => getFocused() === node,
      onBlur: () => blurred++,
    });
    focusNode(node);
    focusNode(null);
    expect(blurred).toBe(1);
    registerEditable(node, null);
  });

  test("openHostChannel rejects unknown service names", () => {
    mountMock([]);
    expect(openHostChannel("nope")).toBeNull();
    expect(openHostChannel("input")).not.toBeNull();
  });
});
