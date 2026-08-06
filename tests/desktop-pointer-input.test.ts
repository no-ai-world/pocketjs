// desktop input.pointer：触点 → onPress；以及 live resize hook 行为

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installHost, installResizeViewportHook, type Host, type HostOps } from "../framework/src/host.ts";
import {
  clearPointerHover,
  enableCursor,
  focusNode,
  getFocused,
  handleFrame,
  hasTextSelectionPointerCapture,
  resetInput,
  setInputRoot,
} from "../framework/src/input.ts";
import { __setFeatureOverridesForTest } from "../framework/src/platform.ts";
import {
  __packTouch,
  __packTouchDesktop,
  __resetTouches,
  __setTouches,
} from "../framework/src/touch.ts";
import { registerSelectable } from "../framework/src/host-input.ts";
import { createTextSelectionHandler } from "../framework/src/text-selection.ts";
import type { NodeMirror } from "../framework/src/renderer.ts";
import { BTN, NODE_TYPE, ROOT_ID } from "../contracts/spec/spec.ts";

type Call = [string, ...unknown[]];

interface MockHost extends Host {
  calls: Call[];
  hitResult: number;
}

function makeHost(): MockHost {
  // 构造可记录 hitTest/setFocus/setActive 的 mock host
  const calls: Call[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const self: MockHost = {
    kind: "injected",
    target: "test",
    strict: true,
    calls,
    hitResult: 0,
    ops: {} as HostOps,
  };
  self.ops = {
    createNode: () => 0,
    destroyNode: rec("destroyNode"),
    insertBefore: rec("insertBefore"),
    removeChild: rec("removeChild"),
    setStyle: rec("setStyle"),
    setProp: rec("setProp"),
    setText: rec("setText"),
    replaceText: rec("replaceText"),
    uploadTexture: () => 1,
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate: () => 1,
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    setActive: rec("setActive"),
    measureText: () => 0,
    uploadImgEntry: () => 1,
    freeTexture: rec("freeTexture"),
    hitTest(x: number, y: number) {
      calls.push(["hitTest", x, y]);
      return self.hitResult;
    },
  };
  return self;
}

function mk(id: number, parent: NodeMirror | null, extra: Partial<NodeMirror> = {}): NodeMirror {
  // 手写 mirror 节点
  const n: NodeMirror = {
    id,
    type: NODE_TYPE.view,
    parent,
    children: [],
    ...extra,
  };
  if (parent) parent.children.push(n);
  return n;
}

let host: MockHost;
let root: NodeMirror;

beforeEach(() => {
  host = makeHost();
  installHost(host);
  resetInput();
  __resetTouches();
  __setFeatureOverridesForTest({ "input.pointer": true });
  root = mk(ROOT_ID, null);
  setInputRoot(root);
});

afterEach(() => {
  __setFeatureOverridesForTest(null);
  __resetTouches();
  resetInput();
});

describe("desktop pointer contact → onPress", () => {
  test("desktop primary pointer focuses and fires onPress on CIRCLE release", () => {
    // 模拟 app-chrome host：frame_with_touches + CIRCLE
    let presses = 0;
    const button = mk(5, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;

    __setTouches([__packTouchDesktop(120, 80)]);
    handleFrame(0);
    expect(getFocused()?.id).toBe(button.id);
    expect(host.calls.some((c) => c[0] === "hitTest" && c[1] === 120 && c[2] === 80)).toBe(true);

    handleFrame(BTN.CIRCLE); // press
    handleFrame(0); // release over same target
    expect(presses).toBe(1);
  });

  test("selectable text inside a button does not swallow the button press", () => {
    // 回归：按钮内 Text 默认注册 selectable，按下文字区时会设置
    // selectableCapture；真实指针分支必须仍把 press 交给按钮，
    // 只有拖拽选择（dragged）才抑制。
    let presses = 0;
    const button = mk(5, root, {
      focusable: true,
      focusKind: "action",
      onPress: () => {
        presses += 1;
      },
    });
    const label = mk(4, button, { type: NODE_TYPE.text });
    registerSelectable(label, createTextSelectionHandler(label));
    host.hitResult = label.id; // hitTest 命中文字，按钮是可聚焦祖先
    try {
      __setTouches([__packTouchDesktop(60, 40)]);
      handleFrame(BTN.CIRCLE); // press on the label inside the button
      // 前提必须成立：按下帧确实捕获了文字（否则本测试退化成普通 press 测试）
      expect(hasTextSelectionPointerCapture()).toBe(true);
      handleFrame(0); // release without dragging
      expect(presses).toBe(1);
      expect(hasTextSelectionPointerCapture()).toBe(false);
    } finally {
      // 断言失败也释放注册，避免 selectable pump 泄漏到后续测试文件
      registerSelectable(label, null);
    }
  });

  test("desktop hover does not focus editable controls before a click", () => {
    const input = mk(5, root, { focusable: true, focusKind: "editable" });
    const button = mk(6, root, { focusable: true, focusKind: "action" });
    host.hitResult = input.id;

    __setTouches([__packTouchDesktop(120, 80)]);
    handleFrame(0);
    expect(getFocused()).toBeNull();

    handleFrame(BTN.CIRCLE);
    expect(getFocused()).toBe(input);

    host.hitResult = button.id;
    handleFrame(0);
    expect(getFocused()).toBe(button);

    host.hitResult = 0;
    handleFrame(0);
    expect(getFocused()).toBeNull();
  });

  test("without input.pointer, contacts do not drive onPress", () => {
    // 无 pointer capability 时触点不能走 pointerContactFrame
    __setFeatureOverridesForTest({ "input.pointer": false });
    let presses = 0;
    const button = mk(5, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(10, 10)]);
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(0);
  });

  test("missing desktop pointer does not fall through to stale CIRCLE", () => {
    let presses = 0;
    const button = mk(5, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(20, 20)]);
    handleFrame(0);
    expect(getFocused()).toBe(button);

    __resetTouches();
    handleFrame(0);
    expect(getFocused()).toBeNull();
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(0);
  });

  test("pointer mode never aliases a touch-only contact", () => {
    let presses = 0;
    const button = mk(5, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;
    __setTouches([__packTouch(0, 10, 10)]);
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(0);
  });

  test("switching cursor modes cancels the desktop press target", () => {
    let presses = 0;
    const button = mk(5, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(50, 50)]);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    const disposeCursor = enableCursor();
    disposeCursor();
    __setTouches([__packTouchDesktop(50, 50)]);
    handleFrame(0);
    expect(presses).toBe(0);
  });

  test("held desktop presses retain focus while hover crosses another node", () => {
    const button = mk(6, root, { focusable: true });
    const other = mk(7, root, { focusable: true });
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(50, 50)]);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    host.hitResult = other.id;
    __setTouches([__packTouchDesktop(80, 50)]);
    handleFrame(BTN.CIRCLE);
    expect(getFocused()).toBe(button);
  });

  test("cancel press when contact drags off the pressed node", () => {
    // 拖离按下目标不触发 onPress
    let presses = 0;
    const button = mk(5, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(50, 50)]);
    handleFrame(BTN.CIRCLE);
    host.hitResult = 0; // off target
    __setTouches([__packTouchDesktop(5, 5)]);
    handleFrame(0);
    expect(presses).toBe(0);
  });

  test("re-entry restores the active press and fires on release", () => {
    let presses = 0;
    const button = mk(5, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(50, 50)]);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    host.hitResult = 0;
    __setTouches([__packTouchDesktop(5, 5)]);
    handleFrame(BTN.CIRCLE);
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(50, 50)]);
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(1);
  });

  test("mouse leave keeps a held desktop press owner", () => {
    let presses = 0;
    const button = mk(9, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(60, 60)]);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    clearPointerHover();
    __resetTouches();
    handleFrame(BTN.CIRCLE);
    __setTouches([__packTouchDesktop(60, 60)]);
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(1);
  });

  test("pointer leave cannot retarget a held desktop press on re-entry", () => {
    // 同一物理按住离窗后重入其他控件，不能改写原始 press owner。
    let aPresses = 0;
    let bPresses = 0;
    const a = mk(10, root, {
      focusable: true,
      onPress: () => {
        aPresses += 1;
      },
    });
    const b = mk(11, root, {
      focusable: true,
      onPress: () => {
        bPresses += 1;
      },
    });
    host.hitResult = a.id;
    __setTouches([__packTouchDesktop(60, 60)]);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);

    clearPointerHover();
    __resetTouches();
    handleFrame(BTN.CIRCLE);

    host.hitResult = b.id;
    __setTouches([__packTouchDesktop(80, 60)]);
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect([aPresses, bPresses]).toEqual([0, 0]);
  });

  test("programmatic blur cancels a held desktop press", () => {
    let presses = 0;
    const button = mk(8, root, {
      focusable: true,
      onPress: () => {
        presses += 1;
      },
    });
    host.hitResult = button.id;
    __setTouches([__packTouchDesktop(50, 50)]);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    focusNode(null);
    handleFrame(BTN.CIRCLE);
    handleFrame(0);
    expect(presses).toBe(0);
  });
});

describe("live resize hook", () => {
  test("installResizeViewportHook forwards width/height to the callback", () => {
    // host 调 globalThis.__pocketResizeViewport 时必须进 runtime
    const seen: Array<[number, number]> = [];
    const dispose = installResizeViewportHook((w, h) => {
      seen.push([w, h]);
    });
    const hook = (globalThis as { __pocketResizeViewport?: (w: number, h: number) => void })
      .__pocketResizeViewport;
    expect(typeof hook).toBe("function");
    hook!(640, 480);
    hook!(800, 600);
    expect(seen).toEqual([
      [640, 480],
      [800, 600],
    ]);
    dispose();
    expect(
      (globalThis as { __pocketResizeViewport?: unknown }).__pocketResizeViewport,
    ).toBeUndefined();
  });
});
