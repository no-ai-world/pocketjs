// Native desktop target validation.

import { platform as hostPlatform } from "node:os";

export type DesktopTargetId = "macos-widget" | "windows-widget" | "windows-app";

/** Reject a desktop target that cannot run on the current native OS. */
export function assertDesktopTargetPlatform(
  target: DesktopTargetId,
  currentPlatform: ReturnType<typeof hostPlatform> = hostPlatform(),
): void {
  // Keep launcher target identity aligned with the native binary platform.
  const expectedPlatform = target === "macos-widget" ? "darwin" : "win32";
  if (currentPlatform !== expectedPlatform) {
    throw new Error(
      `${target} requires ${expectedPlatform} (current OS: ${currentPlatform})`,
    );
  }
}
