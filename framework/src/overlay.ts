import type { NodeMirror } from "./renderer.ts";

let overlayRoot: NodeMirror | null = null;

export function setOverlayRoot(root: NodeMirror | null): void {
  overlayRoot = root;
}

export function getOverlayRoot(): NodeMirror {
  if (!overlayRoot) {
    throw new Error("PocketJS: overlay root is not installed");
  }
  return overlayRoot;
}

/** Read the overlay root without requiring a mounted application. */
export function getOverlayRootOrNull(): NodeMirror | null {
  // 读取当前覆盖层根节点。
  return overlayRoot;
}
