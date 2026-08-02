// desktop-widget stock host 不变量（源码 + 可执行 smoke）

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { $ } from "bun";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("desktop-widget host invariants", () => {
  test("CJK fallback does not hardcode drive-letter font files", () => {
    // 字体发现只能用目录/环境变量，不能写死 C:\Windows\Fonts\...
    const src = readFileSync(
      join(root, "engine/pocket3d/examples/note-widget/src/cjk.rs"),
      "utf8",
    );
    expect(src).not.toMatch(/C:\\\\Windows\\\\Fonts/i);
    expect(src).not.toMatch(/C:\\Windows\\Fonts/i);
    expect(src).toContain("POCKETJS_CJK_FONT");
    expect(src).toContain("PREFERRED_FONT_NAMES");
    expect(src).toContain("system_font_dirs");
  });

  test("stock note-widget has no demo feed API and no app-name chrome inference", () => {
    // 生产 host 不承载 demo fetch-feed；chrome 不靠 note-main 字符串推断
    const src = readFileSync(
      join(root, "engine/pocket3d/examples/note-widget/src/lib.rs"),
      "utf8",
    );
    expect(src).not.toContain("fetch-feed");
    expect(src).not.toContain("serve_feed");
    expect(src).not.toContain("POCKETJS_FEED_API");
    expect(src).not.toMatch(/app\s*==\s*"note-main"/);
    expect(src).toContain("Chrome is explicit");
    expect(src).toContain("--chrome");
    expect(src).toContain("ChromeMode");
    // Both desktop chrome modes receive the serialized pointer snapshot.
    expect(src).toContain("if let Some((x, y)) = guest_pointer_pos");
    expect(src).toContain("frame_with_touches");
    expect(src).toContain("shell_svc");
    expect(src).toContain("companion_svc");
    expect(src).toContain("dropping invalid companion JSON line");
    expect(src).toContain("or_insert_with");
    expect(src).toContain("set_svc_allowlist");
    expect(src).toContain("send_shell_hello");
    expect(src).toContain("companion_offline");
    expect(src).toContain("caret_clear");
    expect(src).toContain("encode_utf16");
    expect(src).toContain("KeyCode::KeyA");
    expect(src).toContain('"SelectAll"');
    expect(src).toContain("pointer_pos");
    expect(src).toContain("interaction_cancelled");
    expect(src).toContain("interaction_restored");
    expect(src).toContain('"t": "blur"');
    expect(src).toContain('"t": "focus"');
    expect(src).toContain('("macos-widget", ChromeMode::Note) => Ok(("macos-widget", 4))');
    expect(src).toContain('("windows-widget", ChromeMode::Note) => Ok(("windows-widget", 4))');
    expect(src).toContain('("windows-app", ChromeMode::App) => Ok(("windows-app", 4))');
  });

  test("companion bridge is productized with offline + restart", () => {
    const src = readFileSync(
      join(root, "engine/pocket3d/examples/note-widget/src/companion.rs"),
      "utf8",
    );
    expect(src).toContain("RestartPolicy");
    expect(src).toContain("became_offline");
    expect(src).toContain("max_restarts");
    expect(src).toContain("restart_attempts");
    expect(src).toContain("stderr(Stdio::inherit())");
    expect(src).toContain("sync_channel");
    expect(src).toContain("try_send");
    expect(src).toContain("companion-stdin");
    expect(src).toContain("bridge marked offline");
  });

  test("app-widget is an independent app-only package", () => {
    const cargo = readFileSync(
      join(root, "engine/pocket3d/examples/app-widget/Cargo.toml"),
      "utf8",
    );
    const main = readFileSync(
      join(root, "engine/pocket3d/examples/app-widget/src/main.rs"),
      "utf8",
    );
    expect(cargo).toContain('name = "app-widget"');
    expect(cargo).toContain('note-widget = { path = "../note-widget" }');
    expect(main).toContain("note_widget::run_app()");

    const launcher = readFileSync(join(root, "tools/app-widget.ts"), "utf8");
    expect(launcher).toContain("const planWidth");
    expect(launcher).toContain('if (!hasDesktopFlag(pass, "--width"))');
    expect(launcher).toContain('if (!hasDesktopFlag(pass, "--height"))');
    expect(launcher).toContain('  "--plan",');
    expect(launcher).toContain("resolveDynamicViewportBounds");
    expect(launcher).toContain('["--plan", planPath');
    expect(launcher).toContain('"--min-size"');
    expect(launcher).toContain('"--max-size"');

    const runtime = readFileSync(
      join(root, "engine/pocket3d/examples/note-widget/src/lib.rs"),
      "utf8",
    );
    expect(runtime).toContain('.join("../../../../dist")');
  });

  test("framework exposes TextInput, text-edit, and host-input split", () => {
    const pkg = readFileSync(join(root, "package.json"), "utf8");
    expect(pkg).toContain('"./text-edit"');
    expect(pkg).toContain('"./host-input"');
    expect(pkg).toContain('"app-widget"');
    const components = readFileSync(join(root, "framework/src/components.ts"), "utf8");
    expect(components).toContain("TextInput");
    expect(components).toContain('focusKind: "action"');
    const inputApi = readFileSync(join(root, "framework/src/input-api.ts"), "utf8");
    expect(inputApi).toContain("connectHostInput");
    expect(inputApi).toContain("connectCompanion");
    expect(inputApi).toContain("pointerPosition");
    expect(inputApi).toContain("blurFocus");
    expect(inputApi).toContain("restoreFocus");
    expect(inputApi).toContain("moveFocusByTab");
    const frame = readFileSync(join(root, "framework/src/frame.ts"), "utf8");
    expect(frame).toContain("onFramePersistent");
    const hostInput = readFileSync(join(root, "framework/src/host-input.ts"), "utf8");
    expect(hostInput).toContain("pumpDisposer");
    expect(hostInput).toContain("resetHostInputBuffer");
    expect(hostInput).toContain("dispatchMouseEvent");
    expect(hostInput).toContain('"mouse_leave"');
    expect(hostInput).toContain("clearPointerHover");
    expect(hostInput).toContain("outside && ev.d === false");
    expect(hostInput).toContain("else if (!hit) focusNode(null)");
    expect(hostInput).toContain("mouseCapture");
    expect(hostInput).toContain("pumpChannel");
    expect(hostInput).toContain("caret_clear");
    expect(hostInput).toContain("focusNode(null)");
    const mount = readFileSync(join(root, "framework/src/index.ts"), "utf8");
    expect(mount).toContain("resetHostInputBuffer();");

    const noteApp = readFileSync(join(root, "apps/note/app.tsx"), "utf8");
    expect(noteApp).toContain("let hostFocused = true;");
    expect(noteApp).toContain("if (!hostFocused");
    expect(noteApp).toContain("resetCaretReport");
    expect(noteApp).toContain('t: "caret_clear"');
    expect(noteApp).toContain("resetCaretReport(true);");
    expect(noteApp).toContain("const capturedInteraction = hadCapture && down;");
    expect(noteApp).toContain('if (ev.outside === true && !down) {');
    expect(noteApp).toContain("rehover = false");
    expect(noteApp).toContain("const n = hostFocused && m.x >= 0");
    expect(noteApp).toContain('setMouse({ x: -1, y: -1 });');
    expect(noteApp).toContain("const capturedInteraction = hadCapture && down;");
    expect(noteApp).toContain("if (!capturedInteraction)");
    expect(noteApp).toContain('case "mouse_leave"');
    expect(noteApp).toContain("const down = ev.d ?? prevDown;");
    const noteSvc = readFileSync(join(root, "apps/note/svc.ts"), "utf8");
    expect(noteSvc).toContain("connectNoteHost");
    expect(noteSvc).toContain('"blur"');
    expect(noteSvc).toContain('"focus"');
    expect(noteSvc).not.toMatch(/(?:ops\.)?svcPoll\(/);
  });

  test("note launcher requests sticky chrome explicitly and rejects unknown OS defaults", () => {
    // bun run note 必须显式 --chrome note，且非 win/mac 不能默默选 macos
    const src = readFileSync(join(root, "tools/note.ts"), "utf8");
    expect(src).toContain("--chrome note");
    expect(src).toContain('os === "darwin"');
    expect(src).toContain('os === "win32"');
    expect(src).toContain("no stock desktop-widget target");
    expect(src).toContain("JSON.stringify(resolution.plan");
    expect(src).toContain('"--plan"');
    expect(src).toContain("--proof cannot be combined");
    expect(src).toContain("launchArgs");
    const runtime = readFileSync(
      join(root, "engine/pocket3d/examples/note-widget/src/lib.rs"),
      "utf8",
    );
    expect(runtime).toContain("cursor_present");
    expect(runtime).toContain("mouse_leave");
    expect(runtime).toContain("last_mouse_release");
    expect(runtime).toContain("pointer_pulse");
    expect(runtime).toContain("pointer_buttons");
    expect(runtime).toContain("mouse_button_clicks");
    expect(runtime).toContain("mouse_button_press_positions");
    expect(runtime).toContain("mouse_button_released_outside");
    expect(runtime).toContain("fast_clicks");
    expect(runtime).toContain("physical_press");
    expect(runtime).toContain("PointerPulse");
    expect(runtime).toContain("DEFAULT_MAX_SIZE");
    expect(runtime).toContain("validate_resolved_plan");
  });

  test("docs and shell expose explicit transparent degrade", () => {
    // 文档与 API 承认 Windows 可能降到 opaque
    const docs = readFileSync(join(root, "docs/WIDGET.md"), "utf8");
    expect(docs).toContain("Stock `app-widget` is the generic desktop App Shell");
    expect(docs).toContain("Transparent may degrade on Windows");
    expect(docs).toContain("display_transparent()");

    const shell = readFileSync(
      join(root, "engine/crates/pocket-widget/src/shell.rs"),
      "utf8",
    );
    expect(shell).toContain("pub fn display_transparent");
    expect(shell).toContain("pub fn clear_display_transparent");
    expect(shell).toContain("set_display_transparent");
    expect(shell).toContain("pocket-widget: display_transparent=");
    expect(shell).not.toContain("POCKETJS_DISPLAY_TRANSPARENT");
  });

  test("note-widget rejects illegal host identity before asset boot", async () => {
    // 非法 host 应在读 bundle 前失败；缺 bin 时先 release 构建
    const binName = platform() === "win32" ? "note-widget.exe" : "note-widget";
    const engineRoot = join(root, "engine");
    const bin = join(engineRoot, "target/release", binName);
    if (!existsSync(bin)) {
      const build = await $`cargo build --release -p note-widget`.cwd(engineRoot).nothrow();
      expect(build.exitCode).toBe(0);
    }
    expect(existsSync(bin)).toBe(true);
    const plan = join(root, ".pocket/desktop-widget/host-identity-test.plan.json");
    mkdirSync(dirname(plan), { recursive: true });
    await Bun.write(
      plan,
      JSON.stringify({
        target: { id: "windows-widget", hostAbi: 4 },
        viewport: { logical: [420, 560] },
      }),
    );
    try {
      const result = await $`${bin} --host not-a-host --plan ${plan} --app missing-app`.nothrow().quiet();
      const err = `${result.stdout}${result.stderr}`;
      expect(result.exitCode).not.toBe(0);
      expect(err).toMatch(/unsupported desktop host id/i);
      expect(err).not.toMatch(/cannot find PocketJS dist/i);
    } finally {
      unlinkSync(plan);
    }
  });
});
