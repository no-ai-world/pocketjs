// Text-glyph runtime reporting contract — rendered non-ASCII text must reach
// the host through ensure_text so the native host can rasterize missing CJK
// glyphs (text.glyphs.runtime). The reporter lives at the native-tree text
// boundary (createTextNode/replaceText) so Solid and Vue Vapor share it, and
// hot.text reports through the same entry so per-frame writes cannot skip it.
//
// Run: bun test --conditions=browser tests/text-glyph-report.test.ts

import { beforeEach, describe, expect, test } from "bun:test";
import type { Host, HostOps } from "../framework/src/host.ts";
import { installHost } from "../framework/src/host.ts";
import { NODE_TYPE } from "../contracts/spec/spec.ts";
import { createTextNode, replaceText, setTextContentReporter } from "../framework/src/native-tree.ts";
import { text as hotText } from "../framework/src/hot.ts";
import { resetRendererState } from "../framework/src/renderer.ts";

// Importing host-input registers the reporter; keep it first so the module
// side effect is in place before any node is created.
import {
  __resetTextGlyphReporterForTest,
  ensureText,
  flushTextGlyphs,
} from "../framework/src/host-input.ts";

interface MockHost extends Host {
  sent: string[];
  svcAllowed: boolean;
}

function makeMockHost(): MockHost {
  const sent: string[] = [];
  let nextId = 2;
  const ops: HostOps = {
    createNode(): number {
      return nextId++;
    },
    destroyNode(): void {},
    insertBefore(): void {},
    removeChild(): void {},
    setStyle(): void {},
    setProp(): void {},
    setText(): void {},
    replaceText(): void {},
    uploadTexture(): void {},
    svcOpen(): boolean {
      return this.svcAllowed;
    },
    svcPoll(): string | undefined {
      return undefined;
    },
    svcSend(line: string): void {
      sent.push(line);
    },
  };
  const host = { ops, kind: "injected" as const, target: "test" as const, strict: true, sent, svcAllowed: true };
  ops.svcOpen = ops.svcOpen.bind(host);
  return host;
}

let host: MockHost;

beforeEach(() => {
  host = makeMockHost();
  installHost(host);
  resetRendererState();
  __resetTextGlyphReporterForTest();
});

describe("rendered text glyph reporting", () => {
  test("non-ASCII text node content is reported once as ensure_text", () => {
    createTextNode("电话");
    expect(host.sent).toEqual([JSON.stringify({ t: "ensure_text", text: "电话" })]);
  });

  test("pure ASCII text never reports", () => {
    createTextNode("hello world");
    expect(host.sent).toEqual([]);
  });

  test("already reported codepoints are not re-sent", () => {
    createTextNode("电话");
    createTextNode("手机号码");
    // 新码点「手」「机」「号」「码」才上报，已报的「电」「话」跳过。
    expect(host.sent).toEqual([
      JSON.stringify({ t: "ensure_text", text: "电话" }),
      JSON.stringify({ t: "ensure_text", text: "手机号码" }),
    ]);
  });

  test("replaceText reports only newly seen codepoints", () => {
    const node = createTextNode("备注");
    replaceText(node, "备注·电");
    expect(host.sent).toEqual([
      JSON.stringify({ t: "ensure_text", text: "备注" }),
      JSON.stringify({ t: "ensure_text", text: "·电" }),
    ]);
  });

  test("removing the reporter stops reporting", () => {
    setTextContentReporter(null);
    createTextNode("电话");
    expect(host.sent).toEqual([]);
  });

  test("unavailable channel queues codepoints and flushes once it recovers", () => {
    // Vue Vapor 模板在 channel 建立前解析文本：svcOpen 不可用时消息必须积压，
    // 通道恢复后补发（一次 ensure_text 携带全部积压码点）。
    host.svcAllowed = false;
    createTextNode("电话");
    expect(host.sent).toEqual([]);

    host.svcAllowed = true;
    flushTextGlyphs();
    expect(host.sent).toEqual([JSON.stringify({ t: "ensure_text", text: "电话" })]);

    // 补发后码点已确认，重复文本不再上报。
    host.sent.length = 0;
    createTextNode("电话");
    expect(host.sent).toEqual([]);
  });

  test("flushTextGlyphs is a no-op when nothing is pending", () => {
    flushTextGlyphs();
    expect(host.sent).toEqual([]);
  });

  test("explicit ensureText marks codepoints as reported", () => {
    // 应用显式请求字形后，渲染路径不再重复上报同一码点。
    ensureText("电话");
    host.sent.length = 0;
    createTextNode("电话");
    expect(host.sent).toEqual([]);
  });

  test("explicit ensureText does not mark ASCII", () => {
    ensureText("hello");
    host.sent.length = 0;
    // ASCII 码点不入账本，渲染路径的中文照常上报。
    createTextNode("中文");
    expect(host.sent).toEqual([JSON.stringify({ t: "ensure_text", text: "中文" })]);
  });

  test("hot.text reports non-ASCII content through the same entry", () => {
    const node = createTextNode("a");
    hotText(node, "伤害");
    expect(host.sent).toEqual([JSON.stringify({ t: "ensure_text", text: "伤害" })]);
  });
});
