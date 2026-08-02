// Desktop launcher argv ownership and pass-through boundary tests.

import { describe, expect, test } from "bun:test";
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
});
