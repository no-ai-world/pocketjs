// bun run note [flags…] — build + launch the markdown sticky note
// (engine/pocket3d/examples/note-widget over apps/note, the flat pocket-widget
// runtime; docs/WIDGET.md §2b).
//
//   bun run note                    # your note (~/.pocket-note.md)
//   bun run note -- --file todo.md  # any markdown file
//   bun run note -- --width 380 --height 520
//   bun run note --proof            # headless acceptance: click into the
//                                   # sample, type, autosave round-trips,
//                                   # screenshot lands in dist/
//   bun run note --target windows-widget
//
// The windowed run stays attached to your terminal — quit with the host
// chord (⌘Q on macOS) or Ctrl-C here. On exit the shell prints its governor
// receipt: "pocket-widget: N ticks, M frames rendered" — a settled note
// should show M ≪ N (measured: 2 frames over 481 ticks).
//
// On Windows, transparent composite may degrade; with RUST_LOG=info the host
// logs `pocket-widget: display_transparent=0|1` (also
// pocket_widget::display_transparent() in-process).
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { $ } from "bun";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import {
  resolveDynamicViewportBounds,
  validateAndResolveBuildPlan,
} from "../framework/src/manifest/resolve.ts";
import { assertDesktopTargetPlatform } from "./desktop-target.ts";
import { resolveIconSource, validateIcoFile } from "./desktop-icon.ts";
import {
  assertNoDesktopFlags,
  parseDesktopArgs,
} from "./desktop-args.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const parsedArgs = parseDesktopArgs(process.argv.slice(2), ["--target", "--icon"], ["--proof"]);
const targetOverride = parsedArgs.ownedValues.get("--target");
const iconFlag = parsedArgs.ownedValues.get("--icon");
const proof = parsedArgs.ownedFlags.has("--proof");
const pass = parsedArgs.pass;
assertNoDesktopFlags(pass, [
  "--target",
  "--host",
  "--chrome",
  "--app",
  "--js",
  "--pak",
  "--plan",
  "--title",
  "--icon",
  "--fixed",
  "--min-size",
  "--max-size",
  "--proof",
]);
if (proof && pass.length > 0) {
  throw new Error("pocket-note: --proof cannot be combined with native passthrough flags");
}

function defaultDesktopWidgetTarget(): "macos-widget" | "windows-widget" {
  // 仅在已交付 stock host 的 OS 上选择默认 target
  const os = platform();
  if (os === "win32") return "windows-widget";
  if (os === "darwin") return "macos-widget";
  throw new Error(
    `pocket-note: no stock desktop-widget target on '${os}' (use macOS or Windows, or pass --target)`,
  );
}

const target = (targetOverride ?? defaultDesktopWidgetTarget()) as
  | "macos-widget"
  | "windows-widget";
if (target !== "macos-widget" && target !== "windows-widget") {
  throw new Error(
    `pocket-note: unsupported target '${target}' (expected macos-widget|windows-widget)`,
  );
}
assertDesktopTargetPlatform(target);

// Density, viewport and capability features come from the selected desktop
// widget stock profile — not from ad-hoc flags.
const manifest = await Bun.file(join(root, "apps/note/pocket.json")).json();
const resolution = validateAndResolveBuildPlan(manifest, { target });
if (!resolution.ok) {
  throw new Error(
    `pocket-note: manifest did not resolve for ${target}: ${resolution.diagnostics
      .map((d) => `${d.path || "/"}: ${d.message}`)
      .join("; ")}`,
  );
}
const dynamicBounds = resolveDynamicViewportBounds(manifest, POCKET_TARGETS[target]);
const iconPath = resolveIconSource(iconFlag, manifest.icon, root);
if (iconPath) validateIcoFile(iconPath);
const boundArgs = dynamicBounds
  ? [
      "--min-size",
      `${dynamicBounds.min[0]}x${dynamicBounds.min[1]}`,
      "--max-size",
      `${dynamicBounds.max[0]}x${dynamicBounds.max[1]}`,
    ]
  : [];
const planPath = join(root, ".pocket/desktop-widget/note-main.plan.json");
const launchArgs = ["--plan", planPath, ...boundArgs, ...pass];
if (iconPath) launchArgs.push("--icon", iconPath);
mkdirSync(dirname(planPath), { recursive: true });
await Bun.write(planPath, JSON.stringify(resolution.plan, null, 2) + "\n");

const engineRoot = join(root, "engine");
await $`bun tools/build.ts --plan=${planPath} --project-root=${root}`.cwd(root);
const buildEnv = { ...process.env };
if (iconPath) {
  buildEnv.POCKETJS_ICON = iconPath;
} else {
  // 无图标 = 不嵌入：即使环境里残留全局 POCKETJS_ICON，启动器也不得放行。
  delete buildEnv.POCKETJS_ICON;
}
await $`cargo build --release -p note-widget`.cwd(engineRoot).env(buildEnv);

const binName = platform() === "win32" ? "note-widget.exe" : "note-widget";
const bin = join(engineRoot, "target/release", binName);
const env = {
  ...process.env,
  RUST_LOG: process.env.RUST_LOG ?? "info",
  POCKETJS_HOST: target,
  // dist 是运行期输入：由 launcher 显式声明——构建到哪、就加载哪，
  // 不依赖二进制编译位置（与 tools/widget.ts 的 POCKETJS_DIST 先例一致）。
  POCKETJS_DIST: join(root, "dist"),
};
const noteTitle = "Pocket Note";

if (proof) {
  const shot = join(root, "dist/note-proof.png");
  const file = join(root, "dist/note-proof.md");
  if (existsSync(file)) unlinkSync(file);
  await $`${bin} --host ${target} --chrome note --title ${noteTitle} --file ${file} --screenshot ${shot} --frames 130 --click 350,15@10 --type PROOF-@30 ${launchArgs}`.env(
    env,
  );
  const saved = (await Bun.file(file).text()).includes("PROOF-");
  if (!saved) throw new Error("note proof: autosave round-trip missed the typed text");
  console.log(
    "\nproof: the pencil toggle opened the editor, typing landed at the" +
      "\ncaret, and the debounced autosave wrote the file back out." +
      `\ntarget=${target}\n${shot}`,
  );
  if (platform() === "darwin") {
    await $`open ${shot}`.nothrow();
  } else if (platform() === "win32") {
    await $`cmd /c start "" ${shot}`.nothrow();
  }
} else {
  await $`${bin} --host ${target} --chrome note --title ${noteTitle} ${launchArgs}`.env(env);
}
