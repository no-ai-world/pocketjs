// bun run app-widget — 通用桌面 App Shell（非 note 借壳）
//
//   bun tools/app-widget.ts form
//   bun tools/app-widget.ts form -- --width 520 --height 400
//   bun tools/app-widget.ts form --companion ./my-host.js
//
// 加载任意 app 的 *-main.js/.pak；--chrome app；不绑定 note 文档语义。

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { $ } from "bun";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

function takeFlag(flag: string): string | undefined {
  const i = rawArgs.indexOf(flag);
  if (i < 0) return undefined;
  const value = rawArgs[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  rawArgs.splice(i, 2);
  return value;
}

function defaultDesktopWidgetTarget(): "macos-widget" | "windows-widget" {
  const os = platform();
  if (os === "win32") return "windows-widget";
  if (os === "darwin") return "macos-widget";
  throw new Error(
    `app-widget: no stock desktop-widget target on '${os}' (use macOS or Windows, or pass --target)`,
  );
}

const targetOverride = takeFlag("--target");
const title = takeFlag("--title");
const appName = rawArgs.find((a) => !a.startsWith("--")) ?? "form";
const pass = rawArgs.filter((a) => a !== appName);

const target = (targetOverride ?? defaultDesktopWidgetTarget()) as
  | "macos-widget"
  | "windows-widget";
if (target !== "macos-widget" && target !== "windows-widget") {
  throw new Error(
    `app-widget: unsupported target '${target}' (expected macos-widget|windows-widget)`,
  );
}

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
const planPath = join(root, ".pocket/desktop-widget", `${output}.plan.json`);
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
};

const winTitle = title ?? String(manifest.title ?? output);
await $`${bin} --host ${target} --chrome app --app ${output} --title ${winTitle} ${pass}`.env(
  env,
);
