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
import { mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { platform } from "node:os";
import { $ } from "bun";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

function takeFlag(flag: string): string | undefined {
  // 读取并移除 --flag value
  const i = rawArgs.indexOf(flag);
  if (i < 0) return undefined;
  const value = rawArgs[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  rawArgs.splice(i, 2);
  return value;
}

const targetOverride = takeFlag("--target");
const proof = rawArgs.includes("--proof");
const pass = rawArgs.filter((f) => f !== "--proof");

function defaultDesktopWidgetTarget(): "macos-widget" | "windows-widget" {
  // 按宿主 OS 选择对等 stock target
  return platform() === "win32" ? "windows-widget" : "macos-widget";
}

const target = (targetOverride ?? defaultDesktopWidgetTarget()) as
  | "macos-widget"
  | "windows-widget";
if (target !== "macos-widget" && target !== "windows-widget") {
  throw new Error(
    `pocket-note: unsupported target '${target}' (expected macos-widget|windows-widget)`,
  );
}

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
const planPath = join(root, ".pocket/desktop-widget/note-main.plan.json");
mkdirSync(dirname(planPath), { recursive: true });
await Bun.write(planPath, JSON.stringify(resolution.plan, null, 2) + "\n");

const engineRoot = join(root, "engine");
await $`bun tools/build.ts --plan=${planPath} --project-root=${root}`.cwd(root);
await $`cargo build --release -p note-widget`.cwd(engineRoot);

const binName = platform() === "win32" ? "note-widget.exe" : "note-widget";
const bin = join(engineRoot, "target/release", binName);
const env = {
  ...process.env,
  RUST_LOG: process.env.RUST_LOG ?? "info",
  POCKETJS_HOST: target,
};

if (proof) {
  const shot = join(root, "dist/note-proof.png");
  const file = join(root, "dist/note-proof.md");
  try {
    unlinkSync(file);
  } catch {
    // 证明文件本就不存在
  }
  await $`${bin} --host ${target} --file ${file} --screenshot ${shot} --frames 130 --click 350,15@10 --type PROOF-@30 ${pass}`.env(
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
  await $`${bin} --host ${target} ${pass}`.env(env);
}
