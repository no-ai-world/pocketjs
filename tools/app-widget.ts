// bun run app-widget — 原生 Windows 普通桌面窗口
//
//   bun tools/app-widget.ts form
//   bun tools/app-widget.ts form -- --width 520 --height 400
//   bun tools/app-widget.ts form --companion ./my-host.js
//
// 加载任意 app 的 *-main.js/.pak；使用 Windows 标题栏/系统调整大小，
// 不绑定 Pocket Note 的文档语义。

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { $ } from "bun";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import {
  resolveDynamicViewportBounds,
  validateAndResolveBuildPlan,
} from "../framework/src/manifest/resolve.ts";
import { assertDesktopTargetPlatform } from "./desktop-target.ts";
import {
  assertNoDesktopFlags,
  hasDesktopFlag,
  parseDesktopArgs,
  takeDesktopPositional,
} from "./desktop-args.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const parsedArgs = parseDesktopArgs(process.argv.slice(2), ["--target", "--title"]);
const targetOverride = parsedArgs.ownedValues.get("--target");
const title = parsedArgs.ownedValues.get("--title");
const appSelection = takeDesktopPositional(parsedArgs.pass);
const appName = appSelection.value ?? "form";
const pass = appSelection.pass;

function defaultWindowsAppTarget(): "windows-app" {
  // 选择原生 Windows 普通窗口 target。
  if (platform() === "win32") return "windows-app";
  throw new Error(
    `app-widget: native Windows apps must run on win32 (current OS: ${platform()}); ` +
      "Pocket Note remains available through bun run note on macOS",
  );
}

if (!/^[a-z][a-z0-9-]*$/.test(appName)) {
  throw new Error(`app-widget: invalid app name '${appName}'`);
}
assertNoDesktopFlags(pass, [
  "--target",
  "--host",
  "--chrome",
  "--app",
  "--js",
  "--pak",
  "--plan",
  "--title",
  "--fixed",
  "--min-size",
  "--max-size",
]);

const target = (targetOverride ?? defaultWindowsAppTarget()) as "windows-app";
if (target !== "windows-app") {
  throw new Error(`app-widget: unsupported target '${target}' (expected windows-app)`);
}
assertDesktopTargetPlatform(target);

const manifestPath = join(root, "apps", appName, "pocket.json");
const manifestFile = Bun.file(manifestPath);
if (!(await manifestFile.exists())) {
  throw new Error(`app-widget: missing manifest ${manifestPath}`);
}
const manifest = await manifestFile.json();
const resolution = validateAndResolveBuildPlan(manifest, { target });
if (!resolution.ok) {
  throw new Error(
    `app-widget: manifest did not resolve for ${target}: ${resolution.diagnostics
      .map((d: { path?: string; message: string }) => `${d.path || "/"}: ${d.message}`)
      .join("; ")}`,
  );
}

const output = String(manifest.app?.output ?? `${appName}-main`);
const dynamicBounds = resolveDynamicViewportBounds(manifest, POCKET_TARGETS[target]);
const usesFixedViewport = dynamicBounds === null;
const planPath = join(root, ".pocket/desktop-app", `${output}.plan.json`);
mkdirSync(dirname(planPath), { recursive: true });
await Bun.write(planPath, JSON.stringify(resolution.plan, null, 2) + "\n");

const engineRoot = join(root, "engine");
await $`bun tools/build.ts --plan=${planPath} --project-root=${root}`.cwd(root);
await $`cargo build --release -p app-widget`.cwd(engineRoot);

const binName = platform() === "win32" ? "app-widget.exe" : "app-widget";
const bin = join(engineRoot, "target/release", binName);
const env = {
  ...process.env,
  RUST_LOG: process.env.RUST_LOG ?? "info",
  POCKETJS_HOST: target,
  // dist 是运行期输入：由 launcher 显式声明——构建到哪、就加载哪，
  // 不依赖二进制编译位置（与 tools/widget.ts 的 POCKETJS_DIST 先例一致）。
  POCKETJS_DIST: join(root, "dist"),
};

const winTitle = title ?? String(manifest.title ?? output);
const launchArgs = ["--plan", planPath, ...pass];
const planWidth = String(resolution.plan.viewport.logical[0]);
const planHeight = String(resolution.plan.viewport.logical[1]);
if (usesFixedViewport) {
  if (hasDesktopFlag(pass, "--width") || hasDesktopFlag(pass, "--height")) {
    throw new Error("app-widget: fixed-viewport apps cannot override --width/--height");
  }
  launchArgs.push("--width", planWidth, "--height", planHeight, "--fixed");
} else {
  // Dynamic apps start at the manifest's resolved default; users may still
  // override either dimension for a windowed smoke run.
  if (!hasDesktopFlag(pass, "--width")) launchArgs.push("--width", planWidth);
  if (!hasDesktopFlag(pass, "--height")) launchArgs.push("--height", planHeight);
  if (dynamicBounds) {
    launchArgs.push("--min-size", `${dynamicBounds.min[0]}x${dynamicBounds.min[1]}`);
    launchArgs.push("--max-size", `${dynamicBounds.max[0]}x${dynamicBounds.max[1]}`);
  }
}
await $`${bin} --host ${target} --chrome app --app ${output} --title ${winTitle} ${launchArgs}`.env(
  env,
);
