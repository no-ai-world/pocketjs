import { afterEach, describe, expect, test } from "bun:test";
import {
  __packTouch,
  __packTouchWide,
  __packTouchDesktop,
  __resetTouches,
  __setTouches,
  pointerPosition,
  touches,
} from "../framework/src/touch.ts";

afterEach(__resetTouches);

describe("touch frame snapshot", () => {
  test("decodes stable ids and logical coordinates", () => {
    __setTouches([
      __packTouch(7, 12, 34),
      __packTouch(3, 479, 271),
    ]);
    expect(touches()).toEqual([
      { id: 7, x: 12, y: 34 },
      { id: 3, x: 479, y: 271 },
    ]);
  });

  test("decodes wide E7 coordinates alongside legacy contacts", () => {
    __setTouches([
      __packTouchWide(9, 639, 359),
      __packTouch(3, 479, 271),
    ]);
    expect(touches()).toEqual([
      { id: 9, x: 639, y: 359 },
      { id: 3, x: 479, y: 271 },
    ]);
  });

  test("decodes desktop pointers separately from touch contacts", () => {
    __setTouches([__packTouchDesktop(2400, 1600)]);
    expect(pointerPosition()).toEqual({ x: 2400, y: 1600 });
    expect(touches()).toEqual([]);
    __setTouches(undefined);
    expect(pointerPosition()).toBeNull();
  });

  test("publishes an immutable per-frame snapshot and clears on release", () => {
    const hostValues = [__packTouch(1, 20, 40)];
    __setTouches(hostValues);
    const first = touches();
    hostValues[0] = __packTouch(1, 99, 99);
    expect(first).toEqual([{ id: 1, x: 20, y: 40 }]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);

    __setTouches(undefined);
    expect(touches()).toEqual([]);
  });

  test("drops malformed packed words before decoding", () => {
    __setTouches([NaN, 1.5, -1, 0x1_0000_0000, __packTouch(3, 12, 34)]);
    expect(touches()).toEqual([{ id: 3, x: 12, y: 34 }]);
    expect(pointerPosition()).toBeNull();
  });

  test("caps real touches without consuming the desktop pointer slot", () => {
    __setTouches([
      ...Array.from({ length: 8 }, (_, id) => __packTouch(id, id, id)),
      __packTouchDesktop(900, 700),
    ]);
    expect(touches()).toHaveLength(8);
    expect(pointerPosition()).toEqual({ x: 900, y: 700 });
  });

  test("caps a malformed host frame at the Vita maximum", () => {
    __setTouches(Array.from({ length: 12 }, (_, id) => __packTouch(id, id, id)));
    expect(touches()).toHaveLength(8);
  });
});
