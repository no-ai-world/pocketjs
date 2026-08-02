// Target-neutral touch snapshot delivered at the start of each host frame.
// Coordinates are logical PocketJS pixels, so applications never compensate
// for a Vita panel's sampling grid or the target raster density.

export interface TouchContact {
  /** Stable while this contact remains down; ids may be reused after release. */
  readonly id: number;
  /** Logical viewport X coordinate. */
  readonly x: number;
  /** Logical viewport Y coordinate. */
  readonly y: number;
}

/** Position of the native desktop pointer for the current host frame. */
export interface PointerPosition {
  /** Logical viewport X coordinate. */
  readonly x: number;
  /** Logical viewport Y coordinate. */
  readonly y: number;
}

const LEGACY_COORD_BITS = 9;
const LEGACY_COORD_MASK = (1 << LEGACY_COORD_BITS) - 1;
const LEGACY_ID_SHIFT = LEGACY_COORD_BITS * 2;
const WIDE_MARKER = 0x80000000;
const WIDE_COORD_BITS = 10;
const WIDE_COORD_MASK = (1 << WIDE_COORD_BITS) - 1;
const WIDE_ID_SHIFT = WIDE_COORD_BITS * 2;
// Desktop pointer form: two marker bits + 15-bit x/y. The primary pointer
// has a fixed id of zero, so ordinary Windows windows are not clipped at 1023px.
const DESKTOP_MARKER_MASK = 0xc0000000;
const DESKTOP_MARKER = 0xc0000000;
const DESKTOP_COORD_BITS = 15;
const DESKTOP_COORD_MASK = (1 << DESKTOP_COORD_BITS) - 1;
const EMPTY: readonly TouchContact[] = Object.freeze([]);

let snapshot: readonly TouchContact[] = EMPTY;
let pointerSnapshot: PointerPosition | null = null;

function isPackedWord(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

/**
 * Internal host-frame hook.
 *
 * Existing hosts pack x:9, y:9, id:8 with bit 31 clear. Native viewports
 * wider than 512 use the append-only wide form: bit31=1, x:10, y:10, id:8.
 * Desktop primary pointers use the additional bit31..30=11 form with 15-bit
 * x/y and fixed id 0. That marker is a pointer position, not a touch
 * contact, so it is kept in `pointerPosition()` and omitted from `touches()`.
 * Invalid host words are dropped before bitwise decoding.
 */
export function __setTouches(packed: readonly number[] | undefined): void {
  pointerSnapshot = null;
  if (!packed || packed.length === 0) {
    snapshot = EMPTY;
    return;
  }

  const contacts: TouchContact[] = [];
  for (const value of packed) {
    if (!isPackedWord(value)) continue;
    if (((value & DESKTOP_MARKER_MASK) >>> 0) === DESKTOP_MARKER) {
      if (!pointerSnapshot) {
        pointerSnapshot = Object.freeze({
          x: value & DESKTOP_COORD_MASK,
          y: (value >>> DESKTOP_COORD_BITS) & DESKTOP_COORD_MASK,
        });
      }
      continue;
    }
    if (contacts.length >= 8) break;
    const wide = (value & WIDE_MARKER) !== 0;
    const coordBits = wide ? WIDE_COORD_BITS : LEGACY_COORD_BITS;
    const coordMask = wide ? WIDE_COORD_MASK : LEGACY_COORD_MASK;
    const idShift = wide ? WIDE_ID_SHIFT : LEGACY_ID_SHIFT;
    contacts.push(
      Object.freeze({
        id: (value >>> idShift) & 0xff,
        x: value & coordMask,
        y: (value >>> coordBits) & coordMask,
      }),
    );
  }
  snapshot = Object.freeze(contacts);
}

/** Front-panel contacts for the current frame, in logical viewport pixels. */
export function touches(): readonly TouchContact[] {
  return snapshot;
}

/** Native desktop pointer position for the current frame, if present. */
export function pointerPosition(): PointerPosition | null {
  return pointerSnapshot;
}

export function __resetTouches(): void {
  snapshot = EMPTY;
  pointerSnapshot = null;
}

/** Test/capture helper matching the native frame wire format. */
export function __packTouch(id: number, x: number, y: number): number {
  return (
    ((id & 0xff) << LEGACY_ID_SHIFT) |
    ((y & LEGACY_COORD_MASK) << LEGACY_COORD_BITS) |
    (x & LEGACY_COORD_MASK)
  ) >>> 0;
}

/** Test/native helper for logical viewports up to 1024 pixels per axis. */
export function __packTouchWide(id: number, x: number, y: number): number {
  return (
    WIDE_MARKER |
    ((id & 0xff) << WIDE_ID_SHIFT) |
    ((y & WIDE_COORD_MASK) << WIDE_COORD_BITS) |
    (x & WIDE_COORD_MASK)
  ) >>> 0;
}

/** Desktop primary-pointer wire form, valid for logical viewports up to 32767px. */
export function __packTouchDesktop(x: number, y: number): number {
  return (
    DESKTOP_MARKER |
    ((Math.max(0, Math.min(DESKTOP_COORD_MASK, Math.round(y))) & DESKTOP_COORD_MASK) <<
      DESKTOP_COORD_BITS) |
    (Math.max(0, Math.min(DESKTOP_COORD_MASK, Math.round(x))) & DESKTOP_COORD_MASK)
  ) >>> 0;
}
