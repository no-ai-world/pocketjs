/** Shared argument ownership rules for desktop launchers. */

const PASSTHROUGH_VALUE_FLAGS = new Set([
  "--app",
  "--js",
  "--pak",
  "--plan",
  "--file",
  "--width",
  "--height",
  "--density",
  "--host",
  "--chrome",
  "--title",
  "--min-size",
  "--max-size",
  "--companion",
  "--companion-arg",
  "--companion-cwd",
  "--screenshot",
  "--frames",
  "--click",
  "--shift-click",
  "--drag",
  "--type",
  "--key",
  "--paste",
  "--preedit",
  "--scroll",
  "--auto-quit",
]);

export interface DesktopArgParse {
  ownedFlags: ReadonlySet<string>;
  ownedValues: ReadonlyMap<string, string>;
  pass: string[];
}

/** Parse wrapper-owned flags without inspecting protected passthrough values. */
export function parseDesktopArgs(
  args: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): DesktopArgParse {
  const ownedValueFlags = new Set(valueFlags);
  const ownedBooleanFlags = new Set(booleanFlags);
  const ownedValues = new Map<string, string>();
  const ownedFlags = new Set<string>();
  const pass: string[] = [];
  let passthrough = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!passthrough && arg === "--") {
      passthrough = true;
      continue;
    }
    if (!passthrough && ownedValueFlags.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      ownedValues.set(arg, value);
      i++;
      continue;
    }
    if (!passthrough && ownedBooleanFlags.has(arg)) {
      ownedFlags.add(arg);
      continue;
    }

    pass.push(arg);
    if (PASSTHROUGH_VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      pass.push(value);
      i++;
    }
  }

  return { ownedFlags, ownedValues, pass };
}

/** Reject launcher-owned flags at their actual flag position. */
export function assertNoDesktopFlags(args: readonly string[], forbidden: readonly string[]): void {
  const forbiddenFlags = new Set(forbidden);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (forbiddenFlags.has(arg)) {
      throw new Error(`launcher-controlled flag cannot pass through: ${arg}`);
    }
    if (PASSTHROUGH_VALUE_FLAGS.has(arg)) i++;
  }
}

/** Check whether argv contains a flag outside protected values. */
export function hasDesktopFlag(args: readonly string[], flag: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) return true;
    if (PASSTHROUGH_VALUE_FLAGS.has(arg)) i++;
  }
  return false;
}

/** Remove the first unclaimed positional argument from passthrough argv. */
export function takeDesktopPositional(args: readonly string[]): {
  value: string | undefined;
  pass: string[];
} {
  const pass = [...args];
  for (let i = 0; i < pass.length; i++) {
    const arg = pass[i]!;
    if (PASSTHROUGH_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "--fixed" || arg.startsWith("--")) continue;
    return { value: arg, pass: [...pass.slice(0, i), ...pass.slice(i + 1)] };
  }
  return { value: undefined, pass };
}
