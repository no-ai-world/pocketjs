// Desktop `.ico` plumbing: source resolution, ICONDIR validation, schema
// admission, and (when a win32 release binary is present) a PE resource
// probe. Icons are pure launcher input — nothing here touches the plan.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePNG } from "./png.ts";
import { hasRtIcon, probeRtIcon } from "./pe-icon.ts";
import { resolveIconSource, validateIcoFile } from "../tools/desktop-icon.ts";
import { validatePocketManifest } from "../framework/src/manifest/validate.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A deterministic multi-entry .ico fixture (ICONDIR + PNG entries). */
function icoFixture(sizes: readonly { width: number; height: number }[]): Buffer {
  const entries = sizes.map(({ width, height }) => {
    // Solid-color RGBA block; distinct hue per entry is irrelevant here.
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 0x33;
      rgba[i + 1] = 0x66;
      rgba[i + 2] = 0x99;
      rgba[i + 3] = 0xff;
    }
    return encodePNG(rgba, width, height);
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(entries.length * 16);
  let offset = 6 + entries.length * 16;
  entries.forEach((png, i) => {
    const base = i * 16;
    directory[base] = sizes[i]!.width === 256 ? 0 : sizes[i]!.width;
    directory[base + 1] = sizes[i]!.height === 256 ? 0 : sizes[i]!.height;
    directory.writeUInt16LE(1, base + 4); // planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries]);
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "pocketjs-icon-"));
}

describe("desktop icon source resolution", () => {
  test("CLI --icon wins over the manifest icon", () => {
    const cli = join(fixtureDir(), "cli.ico");
    const resolved = resolveIconSource(cli, "assets/app.ico", root);
    expect(resolved).toBe(cli);
  });

  test("manifest icon resolves against the project root", () => {
    const resolved = resolveIconSource(undefined, "apps/form/app.ico", root);
    expect(resolved).toBe(join(root, "apps/form/app.ico"));
  });

  test("no source means no icon at all", () => {
    expect(resolveIconSource(undefined, undefined, root)).toBeUndefined();
  });

  test("a non-string manifest icon is a clear error", () => {
    expect(() => resolveIconSource(undefined, 42, root)).toThrow(
      "manifest icon must be a non-empty .ico path",
    );
  });
});

describe("validateIcoFile", () => {
  const dir = fixtureDir();
  const valid = join(dir, "app.ico");
  writeFileSync(valid, icoFixture([{ width: 16, height: 16 }, { width: 32, height: 32 }]));

  test("accepts a valid multi-entry .ico", () => {
    expect(() => validateIcoFile(valid)).not.toThrow();
  });

  test("rejects non-.ico extensions (no conversion chain)", () => {
    expect(() => validateIcoFile(join(dir, "app.svg"))).toThrow("not a .ico file");
    expect(() => validateIcoFile(join(dir, "app.png"))).toThrow("not a .ico file");
  });

  test("rejects a missing file", () => {
    expect(() => validateIcoFile(join(dir, "missing.ico"))).toThrow("cannot read");
  });

  test("rejects a wrong ICONDIR magic", () => {
    const bad = join(dir, "bad-magic.ico");
    writeFileSync(bad, Buffer.from([1, 2, 3, 4, 1, 0]));
    expect(() => validateIcoFile(bad)).toThrow("no ICONDIR icon magic");
  });

  test("rejects an entry whose image range runs past the end of the file", () => {
    const bad = join(dir, "overflow.ico");
    // Declare one 16×16 entry whose bytesInRes exceeds the remaining file.
    const png = encodePNG(new Uint8Array(16 * 16 * 4), 16, 16);
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    const entry = Buffer.alloc(16);
    entry[0] = 16;
    entry[1] = 16;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length + 64, 8); // claims more bytes than present
    entry.writeUInt32LE(6 + 16, 12);
    writeFileSync(bad, Buffer.concat([header, entry, png]));
    expect(() => validateIcoFile(bad)).toThrow("runs past the end");
  });

  test("rejects an entry pointing into the ICONDIR directory", () => {
    const bad = join(dir, "into-directory.ico");
    // A 16×16 PNG entry whose image offset lands inside the header itself.
    const png = encodePNG(new Uint8Array(16 * 16 * 4), 16, 16);
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    const entry = Buffer.alloc(16);
    entry[0] = 16;
    entry[1] = 16;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(2, 12); // points into the ICONDIR header, not the image
    writeFileSync(bad, Buffer.concat([header, entry, png]));
    expect(() => validateIcoFile(bad)).toThrow("points into the ICONDIR directory");
  });

  test("rejects an empty entry list", () => {
    const bad = join(dir, "empty.ico");
    writeFileSync(bad, Buffer.from([0, 0, 1, 0, 0, 0]));
    expect(() => validateIcoFile(bad)).toThrow("declares no icon entries");
  });
});

describe("pocket.json icon schema", () => {
  function manifestWithIcon(icon: unknown): unknown {
    return {
      $schema: "https://pocketjs.dev/schema/pocket-2.json",
      pocket: 2,
      id: "dev.pocket-stack.icon-test",
      name: "pocket-icon-test",
      title: "Icon Test",
      version: "0.1.0",
      engine: { capabilities: { requires: ["input.buttons"] } },
      app: {
        entry: "app/main.tsx",
        framework: "solid",
        viewport: { logical: [480, 272], presentation: "native" },
      },
      icon,
    };
  }

  test("accepts a relative .ico path", () => {
    expect(validatePocketManifest(manifestWithIcon("assets/app.ico")).ok).toBe(true);
  });

  test("rejects non-.ico extensions", () => {
    expect(validatePocketManifest(manifestWithIcon("assets/app.svg")).ok).toBe(false);
    expect(validatePocketManifest(manifestWithIcon("assets/app.png")).ok).toBe(false);
  });

  test("rejects absolute paths, .. segments, and backslashes", () => {
    expect(validatePocketManifest(manifestWithIcon("/abs/app.ico")).ok).toBe(false);
    expect(validatePocketManifest(manifestWithIcon("assets/../app.ico")).ok).toBe(false);
    expect(validatePocketManifest(manifestWithIcon("assets\\app.ico")).ok).toBe(false);
  });

  test("unknown top-level fields are still rejected", () => {
    expect(validatePocketManifest(manifestWithIcon("assets/app.ico")).ok).toBe(true);
    const extra = manifestWithIcon("assets/app.ico") as Record<string, unknown>;
    extra.notAField = true;
    expect(validatePocketManifest(extra).ok).toBe(false);
  });
});

describe("PE resource probe", () => {
  test("garbage input is not a PE and carries no icon", () => {
    const dir = fixtureDir();
    const fake = join(dir, "fake.exe");
    writeFileSync(fake, Buffer.from("not a PE at all", "utf8"));
    expect(probeRtIcon(fake)).toBeUndefined();
    expect(hasRtIcon(fake)).toBe(false);
  });

  // A minimal PE32+ whose .rsrc section carries RT_ICON (3) + RT_GROUP_ICON
  // (14) type entries — deterministic on every platform (pure byte math).
  function syntheticPe(withResourceTypes: boolean): Buffer {
    const buffer = Buffer.alloc(0x200 + 0x40);
    buffer.write("MZ", 0, "latin1");
    buffer.writeUInt32LE(0x80, 0x3c); // e_lfanew
    buffer.write("PE\0\0", 0x80, "latin1");
    buffer.writeUInt16LE(0x8664, 0x84); // machine: AMD64
    buffer.writeUInt16LE(1, 0x86); // numberOfSections
    buffer.writeUInt16LE(0xf0, 0x94); // sizeOfOptionalHeader (PE32+)
    buffer.writeUInt16LE(0x20b, 0x98); // optional magic: PE32+
    buffer.writeUInt32LE(16, 0x104); // NumberOfRvaAndSizes
    if (withResourceTypes) {
      buffer.writeUInt32LE(0x1000, 0x118); // data dir[2].rva (resource)
      buffer.writeUInt32LE(0x40, 0x11c); // data dir[2].size
    }
    buffer.write(".rsrc", 0x188, "latin1");
    buffer.writeUInt32LE(0x40, 0x190); // virtualSize
    buffer.writeUInt32LE(0x1000, 0x194); // virtualAddress
    buffer.writeUInt32LE(0x40, 0x198); // sizeOfRawData
    buffer.writeUInt32LE(0x200, 0x19c); // pointerToRawData
    if (withResourceTypes) {
      buffer.writeUInt16LE(0, 0x200); // characteristics
      buffer.writeUInt16LE(0, 0x20c); // NumberOfNamedEntries
      buffer.writeUInt16LE(2, 0x20e); // NumberOfIdEntries
      buffer.writeUInt32LE(3, 0x210); // entry[0].name: RT_ICON
      buffer.writeUInt32LE(0x10, 0x214); // entry[0] → subdirectory
      buffer.writeUInt32LE(14, 0x218); // entry[1].name: RT_GROUP_ICON
      buffer.writeUInt32LE(0x18, 0x21c); // entry[1] → subdirectory
    }
    return buffer;
  }

  test("detects RT_ICON / RT_GROUP_ICON in a resource-bearing PE", () => {
    const dir = fixtureDir();
    const withIcon = join(dir, "with-icon.exe");
    writeFileSync(withIcon, syntheticPe(true));
    const probe = probeRtIcon(withIcon);
    expect(probe).toEqual({ icon: true, groupIcon: true });
    expect(hasRtIcon(withIcon)).toBe(true);
  });

  test("reports no icons for a PE without a resource directory", () => {
    const dir = fixtureDir();
    const bare = join(dir, "bare.exe");
    writeFileSync(bare, syntheticPe(false));
    expect(probeRtIcon(bare)).toBeUndefined();
    expect(hasRtIcon(bare)).toBe(false);
  });

  const releaseExe = join(root, "engine/target/release/app-widget.exe");
  const releaseExeTest = test.skipIf(
    process.platform !== "win32" || !existsSync(releaseExe),
  );
  releaseExeTest("parses the release exe without crashing", () => {
    // The current exe may or may not carry icon resources (it depends on the
    // last `cargo build` with/without POCKETJS_ICON). The probe must never
    // crash on a real production binary and must stay consistent either way.
    const probe = probeRtIcon(releaseExe);
    expect(probe === undefined || typeof probe.icon === "boolean").toBe(true);
    expect(probe === undefined || typeof probe.groupIcon === "boolean").toBe(true);
  });
});
