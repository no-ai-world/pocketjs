// All-Text selection regression coverage: mouse range selection and host copy.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BTN, ENUMS, NODE_TYPE, ROOT_ID } from "../contracts/spec/spec.ts";
import { __advanceClock, resetClock } from "../framework/src/clock.ts";
import { resetFrameHooks, runFrameHooks } from "../framework/src/frame.ts";
import { installHost, type Host, type HostOps, type NodeTextLayout } from "../framework/src/host.ts";
import {
  __resetHostInputForTest,
  registerSelectable,
  runHostInputPump,
} from "../framework/src/host-input.ts";
import { getFocused, handleFrame, resetInput, setHitRoot, setInputRoot } from "../framework/src/input.ts";
import { __setFeatureOverridesForTest } from "../framework/src/platform.ts";
import { __packTouchDesktop, __resetTouches, __setTouches } from "../framework/src/touch.ts";
import { createTextSelectionHandler } from "../framework/src/text-selection.ts";
import { createElement } from "../framework/src/native-tree.ts";
import type { NodeMirror } from "../framework/src/native-tree.ts";
import { setOverlayRoot } from "../framework/src/overlay.ts";
import { render as publicRender } from "../framework/src/index.ts";
import { Text } from "../framework/src/primitives.ts";
import { resetRendererState, rootMirror } from "../framework/src/renderer.ts";

let inbox: string[] = [];
let outbox: string[] = [];
let pollCount = 0;
let hitId = 0;
let hostOps: HostOps;
let nextNodeId = ROOT_ID + 1000;
let text: NodeMirror;
let root: NodeMirror;
let overlay: NodeMirror;
let nativeTextLayout: NodeTextLayout = {
  width: 110,
  fontSlot: 2,
  textAlign: ENUMS.TextAlign.Left,
  tracking: 0,
  lineHeight: 19,
};
let nativeScreenOffset = { x: 0, y: 0 };
let exposeNativeTextLayout = true;
let localPointFailure: "none" | "zero" | "null" = "none";
let selectionRectCalls = 0;

function mountMock(): void {
  nextNodeId = ROOT_ID + 1000;
  hostOps = {
    createNode: () => nextNodeId++,
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
    hitTest: () => hitId,
    nodeLocalPoint: (_id, x, y) => {
      if (localPointFailure === "zero") return 0;
      if (localPointFailure === "null") return null;
      return { x, y };
    },
    ...(exposeNativeTextLayout ? { nodeTextLayout: () => nativeTextLayout } : {}),
    nodeScreenRect: (_id, x, y, width, height) => ({
      x: x + nativeScreenOffset.x,
      y: y + nativeScreenOffset.y,
      width,
      height,
    }),
    nodeTextSelectionRect: (_id, x, y, width, height) => {
      selectionRectCalls++;
      return {
        x: x + nativeScreenOffset.x,
        y: y + nativeScreenOffset.y,
        width,
        height,
      };
    },
    measureText: (value) => value.length * 10,
    svcOpen: () => true,
    svcPoll: () => {
      pollCount++;
      if (inbox.length === 0) return undefined;
      const lines = inbox.join("\n");
      inbox = [];
      return `${lines}\n`;
    },
    svcSend: (line) => outbox.push(line),
  };
  installHost({ kind: "injected", ops: hostOps } as Host);
}

function send(...events: object[]): void {
  inbox.push(...events.map((event) => JSON.stringify({ ...event, src: "shell" })));
  __advanceClock();
  runFrameHooks(0);
}

function frame(buttons: number, ...events: object[]): void {
  inbox.push(...events.map((event) => JSON.stringify({ ...event, src: "shell" })));
  __advanceClock();
  runFrameHooks(buttons);
  handleFrame(buttons);
}

beforeEach(() => {
  inbox = [];
  outbox = [];
  pollCount = 0;
  nativeTextLayout = {
    width: 110,
    fontSlot: 2,
    textAlign: ENUMS.TextAlign.Left,
    tracking: 0,
    lineHeight: 19,
  };
  nativeScreenOffset = { x: 0, y: 0 };
  exposeNativeTextLayout = true;
  localPointFailure = "none";
  selectionRectCalls = 0;
  hitId = 0;
  root = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
  text = {
    id: ROOT_ID + 1,
    type: NODE_TYPE.text,
    parent: root,
    children: [],
    text: "hello world",
    domAttrs: { class: "text-base" },
  };
  root.children.push(text);
  mountMock();
  overlay = createElement("view");
  setOverlayRoot(overlay);
  resetClock();
  resetInput();
  setInputRoot(root);
  setHitRoot(root);
  __resetHostInputForTest();
  resetFrameHooks();
  __resetTouches();
  __setFeatureOverridesForTest({ "input.pointer": true });
  registerSelectable(text, createTextSelectionHandler(text));
});

afterEach(() => {
  registerSelectable(text, null);
  setOverlayRoot(null);
  setHitRoot(null);
  setInputRoot(null);
  __resetHostInputForTest();
  resetInput();
  resetFrameHooks();
  __resetTouches();
  __setFeatureOverridesForTest(null);
});

describe("all-text selection", () => {
  test("selects a mouse range and sends it through the host clipboard channel", () => {
    hitId = text.id;
    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    send({ t: "mouse", x: 50, y: 8, d: false });
    send({ t: "key", k: "Copy" });

    expect(outbox).toContain(JSON.stringify({ t: "copy", text: "ello" }));
    expect(overlay.children.length).toBeGreaterThan(0);
  });

  test("SelectAll copies complete text without making Text a focus target", () => {
    hitId = text.id;
    send({ t: "mouse", x: 0, y: 8, d: true });
    send({ t: "mouse", x: 0, y: 8, d: false });
    send({ t: "key", k: "SelectAll" });
    send({ t: "key", k: "Copy" });

    expect(outbox).toContain(JSON.stringify({ t: "copy", text: "hello world" }));
    // Text is not a focus target: selection must not hand it focus.
    expect(getFocused()).not.toBe(text);
  });

  test("Escape releases active text-selection capture", () => {
    hitId = text.id;
    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    expect(overlay.children.length).toBeGreaterThan(0);

    send({ t: "key", k: "Escape" });
    expect(overlay.children.length).toBe(0);

    hitId = 0;
    send({ t: "mouse", x: 200, y: 8, d: true });
    send({ t: "mouse", x: 240, y: 8 });
    send({ t: "mouse", x: 240, y: 8, d: false });
    expect(overlay.children.length).toBe(0);
  });

  test("Escape releases a collapsed text-selection capture", () => {
    hitId = text.id;
    send({ t: "mouse", x: 10, y: 8, d: true });
    expect(overlay.children.length).toBe(0);

    send({ t: "key", k: "Escape" });
    hitId = 0;
    send({ t: "mouse", x: 200, y: 8, d: true });
    send({ t: "mouse", x: 240, y: 8 });
    send({ t: "mouse", x: 240, y: 8, d: false });

    expect(overlay.children.length).toBe(0);
  });

  test("Escape clears capture even when local mapping failed", () => {
    hitId = text.id;
    localPointFailure = "zero";
    send({ t: "mouse", x: 10, y: 8, d: true });

    send({ t: "key", k: "Escape" });
    localPointFailure = "none";
    hitId = 0;
    send({ t: "mouse", x: 200, y: 8, d: true });
    send({ t: "mouse", x: 240, y: 8 });
    send({ t: "mouse", x: 240, y: 8, d: false });

    expect(overlay.children.length).toBe(0);
  });

  test("the native pointer contact path selects text without shell mouse events", () => {
    hitId = text.id;
    __setTouches([__packTouchDesktop(10, 8)]);
    frame(0);
    frame(BTN.CIRCLE);
    __setTouches([__packTouchDesktop(50, 8)]);
    frame(BTN.CIRCLE);
    frame(0);
    send({ t: "key", k: "Copy" });

    expect(outbox).toContain(JSON.stringify({ t: "copy", text: "ello" }));
  });

  test("native text drag suppresses an action after pointer loss and re-entry", () => {
    let presses = 0;
    const action: NodeMirror = {
      id: ROOT_ID + 2,
      type: NODE_TYPE.view,
      parent: root,
      children: [text],
      focusable: true,
      onPress: () => { presses++; },
    };
    root.children = [action];
    text.parent = action;
    hitId = text.id;

    __setTouches([__packTouchDesktop(10, 8)]);
    frame(0);
    frame(BTN.CIRCLE);
    __setTouches([__packTouchDesktop(50, 8)]);
    frame(BTN.CIRCLE);
    __setTouches([]);
    frame(BTN.CIRCLE);
    __setTouches([__packTouchDesktop(50, 8)]);
    frame(BTN.CIRCLE);
    frame(0);

    expect(presses).toBe(0);
  });

  test("native text layout supplies alignment and line metrics", () => {
    nativeTextLayout = {
      width: 200,
      fontSlot: 2,
      textAlign: ENUMS.TextAlign.Center,
      tracking: 0,
      lineHeight: 19,
    };
    hitId = text.id;
    send({ t: "mouse", x: 55, y: 8, d: true });
    send({ t: "mouse", x: 95, y: 8 });
    send({ t: "mouse", x: 95, y: 8, d: false });
    send({ t: "key", k: "Copy" });

    expect(outbox).toContain(JSON.stringify({ t: "copy", text: "ello" }));
    // Only a consumed nodeTextLayout can center the line: width 200 minus
    // the 110px measured line leaves a 45px alignment offset, so the first
    // selected glyph paints at x=55 (offset + "h" prefix), not x=50.
    const style = (overlay.children[0] as NodeMirror).domAttrs?.style as
      | Record<string, unknown>
      | undefined;
    expect(style?.insetL).toBe(55);
    expect(style?.width).toBe(40);
  });

  test("old hosts leave alignment unset when the text width is unknown", () => {
    exposeNativeTextLayout = false;
    text.domAttrs = { class: "text-base text-center" };
    hitId = text.id;
    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    send({ t: "mouse", x: 50, y: 8, d: false });
    send({ t: "key", k: "Copy" });

    expect(outbox).toContain(JSON.stringify({ t: "copy", text: "ello" }));
  });

  test("explicit native local mapping failures do not create a selection", () => {
    hitId = text.id;
    for (const failure of ["zero", "null"] as const) {
      localPointFailure = failure;
      send({ t: "mouse", x: 10, y: 8, d: true });
      send({ t: "mouse", x: 50, y: 8 });
      send({ t: "mouse", x: 50, y: 8, d: false });
    }

    send({ t: "key", k: "Copy" });
    expect(outbox).not.toContain(JSON.stringify({ t: "copy", text: "ello" }));
    expect(overlay.children.length).toBe(0);
  });

  test("selection rectangles follow a changed native transform", () => {
    hitId = text.id;
    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    send({ t: "mouse", x: 50, y: 8, d: false });
    const before = (overlay.children[0]!.domAttrs?.style as Record<string, unknown>).insetL;
    expect(selectionRectCalls).toBeGreaterThan(0);

    nativeScreenOffset = { x: 25, y: 7 };
    frame(0);
    const afterStyle = overlay.children[0]!.domAttrs?.style as Record<string, unknown>;

    expect(afterStyle.insetL).toBe((before as number) + 25);
    expect(afterStyle.insetT).toBe(7);
  });

  test("a pointer released outside resets the next selection gesture", () => {
    hitId = text.id;
    __setTouches([__packTouchDesktop(10, 8)]);
    frame(0);
    frame(BTN.CIRCLE);
    __setTouches([__packTouchDesktop(50, 8)]);
    frame(BTN.CIRCLE);
    __setTouches([]);
    frame(0);

    __setTouches([__packTouchDesktop(80, 8)]);
    frame(0);
    frame(BTN.CIRCLE);
    frame(0);
    send({ t: "key", k: "Copy" });

    expect(outbox).not.toContain(JSON.stringify({ t: "copy", text: "ello world" }));
    expect(overlay.children.length).toBe(0);
  });

  test("the fixed input phase does not poll again through the persistent hook", () => {
    hitId = text.id;
    inbox.push(JSON.stringify({ t: "mouse", x: 10, y: 8, d: true, src: "shell" }));
    __advanceClock();
    runHostInputPump();
    runFrameHooks(0);

    expect(pollCount).toBe(1);
    expect(overlay.children.length).toBe(0);
  });

  test("a native blank press clears the previous selection", () => {
    hitId = text.id;
    __setTouches([__packTouchDesktop(10, 8)]);
    frame(0);
    frame(BTN.CIRCLE);
    __setTouches([__packTouchDesktop(50, 8)]);
    frame(BTN.CIRCLE);
    frame(0);

    hitId = 0;
    __setTouches([__packTouchDesktop(200, 8)]);
    frame(0);
    frame(BTN.CIRCLE);
    frame(0);
    send({ t: "key", k: "Copy" });

    expect(outbox).not.toContain(JSON.stringify({ t: "copy", text: "hello world" }));
    expect(overlay.children.length).toBe(0);
  });

  test("shift-arrow movement keeps surrogate pairs intact", () => {
    text.text = "A😀B";
    hitId = text.id;
    send({ t: "mouse", x: 0, y: 8, d: true });
    send({ t: "mouse", x: 0, y: 8, d: false });
    send({ t: "key", k: "SelectAll" });
    send({ t: "key", k: "Left", sh: true });
    send({ t: "key", k: "Copy" });

    expect(outbox).toContain(JSON.stringify({ t: "copy", text: "A😀" }));
  });

  test("shell text capture outside release clears action focus", () => {
    const button: NodeMirror = {
      id: ROOT_ID + 2,
      type: NODE_TYPE.view,
      parent: root,
      children: [text],
      focusable: true,
      onPress: () => {},
    };
    root.children = [button];
    text.parent = button;
    hitId = text.id;

    send({ t: "mouse", x: 10, y: 8, d: true });
    expect(getFocused()).toBe(button);
    send({ t: "mouse", x: 200, y: 8, d: false, outside: true });

    expect(getFocused()).toBe(null);
  });

  test("a text drag inside an action does not activate the action", () => {
    let presses = 0;
    const button: NodeMirror = {
      id: ROOT_ID + 2,
      type: NODE_TYPE.view,
      parent: root,
      children: [text],
      focusable: true,
      onPress: () => presses++,
    };
    root.children = [button];
    text.parent = button;
    hitId = text.id;

    __setTouches([__packTouchDesktop(10, 8)]);
    frame(0);
    frame(BTN.CIRCLE, { t: "mouse", x: 10, y: 8, d: true });
    __setTouches([__packTouchDesktop(50, 8)]);
    frame(BTN.CIRCLE, { t: "mouse", x: 50, y: 8 });
    frame(0, { t: "mouse", x: 50, y: 8, d: false });
    send({ t: "key", k: "Copy" });

    expect(presses).toBe(0);
    expect(outbox).toContain(JSON.stringify({ t: "copy", text: "ello" }));
  });

  test("Escape cancels an action press held by a text drag", () => {
    let presses = 0;
    const button: NodeMirror = {
      id: ROOT_ID + 2,
      type: NODE_TYPE.view,
      parent: root,
      children: [text],
      focusable: true,
      onPress: () => presses++,
    };
    root.children = [button];
    text.parent = button;
    hitId = text.id;

    __setTouches([__packTouchDesktop(10, 8)]);
    frame(0);
    frame(BTN.CIRCLE, { t: "mouse", x: 10, y: 8, d: true });
    __setTouches([__packTouchDesktop(50, 8)]);
    frame(BTN.CIRCLE, { t: "mouse", x: 50, y: 8 });
    send({ t: "key", k: "Escape" });
    frame(0, { t: "mouse", x: 50, y: 8, d: false });

    expect(presses).toBe(0);
  });

  test("a text click inside an action still activates the action", () => {
    let presses = 0;
    const button: NodeMirror = {
      id: ROOT_ID + 2,
      type: NODE_TYPE.view,
      parent: root,
      children: [text],
      focusable: true,
      onPress: () => presses++,
    };
    root.children = [button];
    text.parent = button;
    hitId = text.id;

    __setTouches([__packTouchDesktop(10, 8)]);
    frame(0);
    frame(BTN.CIRCLE, { t: "mouse", x: 10, y: 8, d: true });
    frame(0, { t: "mouse", x: 10, y: 8, d: false });

    expect(presses).toBe(1);
  });

  test("shell text capture consumes CIRCLE while the native pointer is missing", () => {
    let presses = 0;
    const button: NodeMirror = {
      id: ROOT_ID + 2,
      type: NODE_TYPE.view,
      parent: root,
      children: [text],
      focusable: true,
      onPress: () => presses++,
    };
    root.children = [button];
    text.parent = button;
    hitId = text.id;

    // Shell mouse-down + drag establishes a visible text selection.
    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    expect(overlay.children.length).toBeGreaterThan(0);

    // No native pointer snapshot: the held CIRCLE press must be consumed
    // by the text capture, not fire the action ancestor.
    __setTouches([]);
    frame(BTN.CIRCLE);
    expect(presses).toBe(0);

    // The subsequent release outside the pointer also does not fire.
    frame(0);
    expect(presses).toBe(0);
  });

  test("a completed shell text drag does not swallow a later native CIRCLE", () => {
    let presses = 0;
    const button: NodeMirror = {
      id: ROOT_ID + 2,
      type: NODE_TYPE.view,
      parent: root,
      children: [text],
      focusable: true,
      onPress: () => presses++,
    };
    root.children = [button];
    text.parent = button;
    hitId = text.id;

    // A shell drag completes a text selection on the action's text; the
    // gesture ends at the shell release (marker cleared).
    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    send({ t: "mouse", x: 50, y: 8, d: false });
    expect(overlay.children.length).toBeGreaterThan(0);

    // No native pointer snapshot: a FRESH CIRCLE press is an ordinary
    // button press on the focused action, not a continuation of the drag.
    __setTouches([]);
    frame(BTN.CIRCLE);
    expect(presses).toBe(1);
    frame(0);
    expect(presses).toBe(1);
  });
});

describe("real Solid <Text> mount", () => {
  test("auto-registers selection through the framework Text component", () => {
    resetRendererState();
    const dispose = publicRender(
      () => Text({ children: "hello world" }) as unknown as NodeMirror,
      { ops: hostOps },
    );
    const appLayer = rootMirror.children[0];
    const textNode = appLayer.children[0] as NodeMirror;
    expect(textNode.type).toBe(NODE_TYPE.text);
    hitId = textNode.id;
    const overlayLayer = rootMirror.children[1];

    // The mounted <Text> registered its own handler — no manual wiring.
    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    send({ t: "mouse", x: 50, y: 8, d: false });
    send({ t: "key", k: "SelectAll" });
    send({ t: "key", k: "Copy" });

    expect(outbox).toContain(JSON.stringify({ t: "copy", text: "hello world" }));
    expect(overlayLayer.children.length).toBeGreaterThan(0);
    // Selection never makes the text node a focus target.
    expect(getFocused()).not.toBe(textNode);

    dispose();
    expect(overlayLayer.children.length).toBe(0);
  });

  test("unmounting the mounted Text clears its selection and stops routing", () => {
    resetRendererState();
    const dispose = publicRender(
      () => Text({ children: "hello world" }) as unknown as NodeMirror,
      { ops: hostOps },
    );
    const textNode = rootMirror.children[0].children[0] as NodeMirror;
    hitId = textNode.id;
    const overlayLayer = rootMirror.children[1];

    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    send({ t: "mouse", x: 50, y: 8, d: false });
    expect(overlayLayer.children.length).toBeGreaterThan(0);

    dispose();
    // A stale hit for the removed node must not resurrect a selection.
    send({ t: "mouse", x: 10, y: 8, d: true });
    send({ t: "mouse", x: 50, y: 8 });
    send({ t: "mouse", x: 50, y: 8, d: false });
    expect(overlayLayer.children.length).toBe(0);
  });
});
