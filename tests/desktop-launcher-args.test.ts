// Desktop launcher argv ownership and pass-through boundary tests.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoDesktopFlags,
  hasDesktopFlag,
  parseDesktopArgs,
  takeDesktopPositional,
} from "../tools/desktop-args.ts";

describe("desktop launcher arguments", () => {
  test("protects companion values that look like launcher flags", () => {
    const parsed = parseDesktopArgs(
      [
        "--target",
        "windows-widget",
        "--companion-arg",
        "--target",
        "--companion-arg",
        "--proof",
      ],
      ["--target"],
      ["--proof"],
    );

    expect(parsed.ownedValues.get("--target")).toBe("windows-widget");
    expect(parsed.ownedFlags.has("--proof")).toBe(false);
    expect(parsed.pass).toEqual([
      "--companion-arg",
      "--target",
      "--companion-arg",
      "--proof",
    ]);
    expect(() => assertNoDesktopFlags(parsed.pass, ["--target", "--proof"])).not.toThrow();
  });

  test("keeps the separator from changing protected pass-through values", () => {
    const parsed = parseDesktopArgs(
      ["--target", "windows-widget", "--", "--companion-arg", "--title"],
      ["--target"],
    );

    expect(parsed.ownedValues.get("--target")).toBe("windows-widget");
    expect(parsed.pass).toEqual(["--companion-arg", "--title"]);
    expect(() => assertNoDesktopFlags(parsed.pass, ["--title"])).not.toThrow();
  });

  test("rejects an actual launcher flag after the separator", () => {
    const parsed = parseDesktopArgs(["--", "--title", "custom"], ["--target"]);
    expect(() => assertNoDesktopFlags(parsed.pass, ["--title"])).toThrow(
      "launcher-controlled flag",
    );
  });

  test("does not mistake protected values for launcher overrides", () => {
    expect(hasDesktopFlag(["--companion-arg", "--width"], "--width")).toBe(false);
    expect(hasDesktopFlag(["--width", "520"], "--width")).toBe(true);
  });

  test("does not mistake protected values for the app name", () => {
    expect(
      takeDesktopPositional(["--companion-arg", "--title", "form", "--auto-quit", "1"]),
    ).toEqual({ value: "form", pass: ["--companion-arg", "--title", "--auto-quit", "1"] });
  });

  test("requires values for passthrough flags", () => {
    expect(() => parseDesktopArgs(["--companion-arg"], [])).toThrow(
      "--companion-arg needs a value",
    );
  });

  test("--icon is consumed as a wrapper-owned flag", () => {
    const parsed = parseDesktopArgs(
      ["--icon", "assets/app.ico", "--target", "windows-app"],
      ["--target", "--icon"],
    );
    expect(parsed.ownedValues.get("--icon")).toBe("assets/app.ico");
    expect(parsed.pass).toEqual([]);
    expect(() => assertNoDesktopFlags(parsed.pass, ["--icon"])).not.toThrow();
  });

  test("--icon after the separator is not wrapper-owned", () => {
    const parsed = parseDesktopArgs(["--", "--icon", "x.ico"], ["--icon"]);
    expect(parsed.ownedValues.has("--icon")).toBe(false);
    expect(parsed.pass).toEqual(["--icon", "x.ico"]);
    expect(() => assertNoDesktopFlags(parsed.pass, ["--icon"])).toThrow(
      "launcher-controlled flag",
    );
  });

  test("--icon requires a value", () => {
    expect(() => parseDesktopArgs(["--icon"], ["--icon"])).toThrow(
      "--icon needs a value",
    );
  });

  test("launchers pass POCKETJS_DIST to the native binary", () => {
    // dist 是运行期输入，必须由 launcher 显式传给原生二进制（构建到哪、加载哪）。
    // 回归保护：若 launcher 再漏传 POCKETJS_DIST，二进制将退回 cwd 的 ./dist，
    // 在非仓库根目录运行时会失败（junction 共享产物时曾去错误的 dist 找 js/pak）。
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const launcher of ["tools/app-widget.ts", "tools/note.ts"]) {
      const src = readFileSync(join(root, launcher), "utf8");
      expect(src.includes(`POCKETJS_DIST: join(root, "dist")`)).toBe(true);
    }
  });
});
