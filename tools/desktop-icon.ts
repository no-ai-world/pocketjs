// Desktop icon plumbing for the Windows app-widget / note-widget launchers.
//
// Icon input is strictly `.ico` — user-supplied, never hardcoded, no
// conversion chain. The launcher resolves the source (`--icon` CLI wins over
// the manifest's top-level `icon`), validates the file (extension +
// existence + ICONDIR magic + entry bounds), then:
//   1. sets `POCKETJS_ICON` for the cargo build so each crate's build.rs
//      embeds the icon as the exe's RT_ICON/RT_GROUP_ICON resources;
//   2. passes `--icon <abs path>` to the binary so the host sets the
//      per-app window icon.
//
// The icon is pure launcher input: it never enters the build plan, so plan
// hashes stay deterministic (icons are not plan data). With no source at
// all, no icon is embedded and no window icon is set — the exe keeps the
// system default.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** ICONDIR type field: 1 = icon (reserved must be 0) → magic `00 00 01 00`. */
const ICONDIR_TYPE_ICON = 1;

/** Every ICONDIRENTRY is 16 bytes: 4 + 4 header fields, then 8 bytes of bounds. */
const ICONDIRENTRY_SIZE = 16;
const ICONDIR_HEADER_SIZE = 6;

/**
 * Resolve the icon source: CLI `--icon` wins over the manifest's top-level
 * `icon`; neither → no icon. Returns an absolute path for the CLI (resolved
 * against the caller's cwd) or the manifest value resolved against the
 * project root.
 */
export function resolveIconSource(
  cliIcon: string | undefined,
  manifestIcon: unknown,
  projectRoot: string,
): string | undefined {
  if (cliIcon !== undefined) {
    return resolve(cliIcon);
  }
  if (manifestIcon === undefined) return undefined;
  if (typeof manifestIcon !== "string" || manifestIcon.length === 0) {
    throw new Error("desktop icon: manifest icon must be a non-empty .ico path");
  }
  return resolve(join(projectRoot, manifestIcon));
}

/**
 * Validate a `.ico` file: extension, existence, ICONDIR magic, at least one
 * entry, and every entry's image range inside the file. Throws a clear error
 * on any failure — never silently falls back to the system default.
 */
export function validateIcoFile(path: string): void {
  if (!path.toLowerCase().endsWith(".ico")) {
    throw new Error(
      `desktop icon: ${path} is not a .ico file (only .ico input is supported; ` +
        "no conversion from .svg/.png)",
    );
  }
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    throw new Error(`desktop icon: cannot read ${path}: ${(error as Error).message}`);
  }
  if (data.length < ICONDIR_HEADER_SIZE) {
    throw new Error(`desktop icon: ${path} is too small to be an ICONDIR .ico file`);
  }
  if (data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== ICONDIR_TYPE_ICON) {
    throw new Error(`desktop icon: ${path} has no ICONDIR icon magic (00 00 01 00)`);
  }
  const count = data.readUInt16LE(4);
  if (count === 0) {
    throw new Error(`desktop icon: ${path} declares no icon entries`);
  }
  const directoryBytes = ICONDIR_HEADER_SIZE + count * ICONDIRENTRY_SIZE;
  if (data.length < directoryBytes) {
    throw new Error(
      `desktop icon: ${path} is truncated (ICONDIR declares ${count} entries)`,
    );
  }
  for (let i = 0; i < count; i++) {
    const entry = ICONDIR_HEADER_SIZE + i * ICONDIRENTRY_SIZE;
    const bytesInRes = data.readUInt32LE(entry + 8);
    const imageOffset = data.readUInt32LE(entry + 12);
    if (imageOffset < directoryBytes) {
      throw new Error(
        `desktop icon: ${path} entry ${i + 1} points into the ICONDIR directory`,
      );
    }
    if (imageOffset + bytesInRes > data.length) {
      throw new Error(
        `desktop icon: ${path} entry ${i + 1} runs past the end of the file`,
      );
    }
  }
}
