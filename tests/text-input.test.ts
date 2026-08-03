// TextInput controlled-input regression coverage.

import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsxPlugin } from "../framework/compiler/jsx-plugin.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const REPLAY_ENTRY = `
  import { createSignal } from "solid-js";
  import { TextInput } from "./framework/src/text-input.tsx";
  import { render, resetRendererState, type NodeMirror } from "./framework/src/renderer.ts";
  import { installHost, type Host, type HostOps } from "./framework/src/host.ts";
  import { focusNode, resetInput, setInputRoot } from "./framework/src/input.ts";
  import { __resetHostInputForTest } from "./framework/src/host-input.ts";
  import { __advanceClock, resetClock } from "./framework/src/clock.ts";
  import { resetFrameHooks, runFrameHooks } from "./framework/src/frame.ts";
  import { NODE_TYPE, ROOT_ID } from "./contracts/spec/spec.ts";

  export function replaySequentialTyping(): string[] {
    let nextId = ROOT_ID + 1;
    let inbox: string[] = [];
    const ops: HostOps = {
      createNode: () => nextId++, destroyNode: () => {}, insertBefore: () => {}, removeChild: () => {},
      setStyle: () => {}, setProp: () => {}, setText: () => {}, replaceText: () => {},
      uploadTexture: () => 0, setImage: () => {}, setSprite: () => {}, animate: () => 0, cancelAnim: () => {},
      setFocus: () => {}, measureText: (text) => text.length * 10,
      svcOpen: () => true,
      svcPoll: () => { const out = inbox.join("\\n"); inbox = []; return out || undefined; },
      svcSend: () => {}, __host: "windows-app", __hostAbi: 4,
    };
    installHost({ kind: "injected", ops } as Host);
    resetRendererState(); resetInput(); __resetHostInputForTest(); resetFrameHooks(); resetClock();
    const root: NodeMirror = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
    setInputRoot(root);
    const [value, setValue] = createSignal("");
    const changes: string[] = [];
    const dispose = render(
      () => TextInput({
        get value() { return value(); },
        onChange: (next) => { changes.push(next); setValue(next); },
        measure: (text) => text.length * 10,
      }),
      root,
    );
    focusNode(root.children[0]!);
    __advanceClock(); runFrameHooks(0);
    for (const character of "abc") {
      inbox.push(JSON.stringify({ t: "ch", s: character, src: "shell" }));
      __advanceClock(); runFrameHooks(0);
    }
    dispose();
    return changes;
  }
`;

async function replaySequentialTyping(): Promise<string[]> {
  const entry = join(ROOT, `.tmp-text-input-${process.pid}.ts`);
  await writeFile(entry, REPLAY_ENTRY);
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      conditions: ["browser"],
      plugins: [jsxPlugin("solid")],
    });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    const code = await result.outputs[0]!.text();
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as {
      replaySequentialTyping(): string[];
    };
    return module.replaySequentialTyping();
  } finally {
    await rm(entry, { force: true });
  }
}

describe("TextInput controlled updates", () => {
  test("advances the caret before the next sequential character", async () => {
    expect(await replaySequentialTyping()).toEqual(["a", "ab", "abc"]);
  });
});
