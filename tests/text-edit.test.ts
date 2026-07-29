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
  openHostChannel,
} from "../framework/src/host-input.ts";
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

  function mountMock(lines: string[]) {
    inbox = [...lines];
    outbox = [];
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
      svcOpen: (name: string) => name === "input" || name === "note",
      svcPoll: () => {
        if (inbox.length === 0) return undefined;
        const batch = inbox.join("\n") + "\n";
        inbox.length = 0;
        return batch;
      },
      svcSend: (line: string) => {
        outbox.push(line);
      },
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

  test("openHostChannel rejects unknown service names", () => {
    mountMock([]);
    expect(openHostChannel("nope")).toBeNull();
    expect(openHostChannel("input")).not.toBeNull();
  });
});
