// tests/pe-icon.ts — minimal PE resource-directory probe for the desktop
// icon tests: does a Windows exe carry RT_ICON (3) / RT_GROUP_ICON (14)?
//
// Walks DOS header → PE signature → optional header → data directories →
// resource directory, then scans the level-1 resource types. Returns
// `undefined` for anything that is not a parseable PE (garbage input or a
// missing file) instead of throwing — this is a probe, not a verifier.

import { readFileSync } from "node:fs";

/** RT_ICON / RT_GROUP_ICON resource type ids (winuser.h). */
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

export interface RtIconProbe {
  /** RT_ICON (3) resource-type directory present. */
  readonly icon: boolean;
  /** RT_GROUP_ICON (14) resource-type directory present. */
  readonly groupIcon: boolean;
}

const SECTION_HEADER_SIZE = 40;

/** True when the exe embeds an RT_ICON resource (Explorer/taskbar icon). */
export function hasRtIcon(path: string): boolean {
  return probeRtIcon(path)?.icon === true;
}

export function probeRtIcon(path: string): RtIconProbe | undefined {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return undefined;
  }
  const resourceRva = resourceDirectoryRva(data);
  if (resourceRva === undefined) return undefined;
  const rootOffset = rvaToOffset(data, resourceRva);
  if (rootOffset === undefined) return undefined;
  const typeIds = resourceTypeIds(data, rootOffset);
  if (typeIds === undefined) return undefined;
  return { icon: typeIds.has(RT_ICON), groupIcon: typeIds.has(RT_GROUP_ICON) };
}

function resourceDirectoryRva(data: Buffer): number | undefined {
  // DOS header must exist and point at the PE header.
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) return undefined; // "MZ"
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 > data.length || data.toString("latin1", pe, pe + 4) !== "PE\0\0") {
    return undefined;
  }
  const coff = pe + 4;
  const numberOfSections = data.readUInt16LE(coff + 2);
  const sizeOfOptionalHeader = data.readUInt16LE(coff + 16);
  if (numberOfSections === 0 || sizeOfOptionalHeader < 112) return undefined;
  const optional = coff + 20;
  const magic = data.readUInt16LE(optional);
  // IMAGE_OPTIONAL_HEADER: NumberOfRvaAndSizes / data directories differ by
  // 16 bytes between PE32 (0x10b) and PE32+ (0x20b).
  const rvaAndSizesOffset = magic === 0x20b ? optional + 108 : magic === 0x10b ? optional + 92 : undefined;
  if (rvaAndSizesOffset === undefined) return undefined;
  const count = data.readUInt32LE(rvaAndSizesOffset);
  if (count <= 2) return undefined;
  // Data directory index 2 = resource table: { rva, size }. RVA 0 means the
  // image declares NO resource directory (the spec's empty marker) — never
  // let a hand-crafted first-section-at-0 PE turn that into a false parse.
  const rva = data.readUInt32LE(rvaAndSizesOffset + 4 + 2 * 8);
  return rva === 0 ? undefined : rva;
}

function rvaToOffset(data: Buffer, rva: number): number | undefined {
  const pe = data.readUInt32LE(0x3c);
  const coff = pe + 4;
  const numberOfSections = data.readUInt16LE(coff + 2);
  const sizeOfOptionalHeader = data.readUInt16LE(coff + 16);
  const sectionTable = coff + 20 + sizeOfOptionalHeader;
  for (let i = 0; i < numberOfSections; i++) {
    const section = sectionTable + i * SECTION_HEADER_SIZE;
    if (section + SECTION_HEADER_SIZE > data.length) return undefined;
    const virtualSize = data.readUInt32LE(section + 8);
    const virtualAddress = data.readUInt32LE(section + 12);
    const sizeOfRawData = data.readUInt32LE(section + 16);
    const pointerToRawData = data.readUInt32LE(section + 20);
    const span = Math.max(virtualSize, sizeOfRawData);
    if (rva >= virtualAddress && rva < virtualAddress + span) {
      const offset = pointerToRawData + (rva - virtualAddress);
      return offset < data.length ? offset : undefined;
    }
  }
  return undefined;
}

/**
 * Scan the level-1 resource directory (resource types) and return the set
 * of numeric type ids. Directory offsets are relative to the root of the
 * resource directory, so nested traversal starts from `rootOffset`.
 */
function resourceTypeIds(data: Buffer, rootOffset: number): Set<number> | undefined {
  const ids = new Set<number>();
  const named = countDirectoryEntries(data, rootOffset);
  if (named === undefined) return undefined;
  const total = named.named + named.id;
  for (let i = 0; i < total; i++) {
    const entry = rootOffset + 16 + i * 8;
    if (entry + 8 > data.length) return undefined;
    const name = data.readUInt32LE(entry);
    if (name & 0x8000_0000) continue; // named entry — not a numeric type id
    ids.add(name & 0xffff);
  }
  return ids;
}

function countDirectoryEntries(
  data: Buffer,
  offset: number,
): { named: number; id: number } | undefined {
  if (offset + 16 > data.length) return undefined;
  return {
    named: data.readUInt16LE(offset + 12),
    id: data.readUInt16LE(offset + 14),
  };
}
