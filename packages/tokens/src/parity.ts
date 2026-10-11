/**
 * Token parity: does the generated CSS reproduce the custom properties a
 * project ships today? Used to prove an import is faithful before a project
 * switches to the generated file.
 */
import { parseCssColor, sameColor } from "./color.ts";
import { customProperties, parseShadow } from "./css.ts";
import type { BlockRef } from "./import.ts";

export interface ParityDifference {
  readonly variable: string;
  readonly mode: "light" | "dark";
  readonly expected: string;
  readonly actual: string;
}

export interface ParityReport {
  readonly matched: number;
  readonly different: readonly ParityDifference[];
  /** Declared by the project, not produced by the build. */
  readonly missing: ReadonlyArray<{ variable: string; mode: "light" | "dark" }>;
  /** Produced by the build, not declared by the project (new tokens). */
  readonly added: readonly string[];
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").replace(/(^|[\s(,])0\./g, "$1.").replace(/\b0px\b/g, "0").trim().toLowerCase();
}

/** Same value, allowing for formatting: colour notation, `0px` vs `0`, `.5` vs `0.5`, an omitted spread. */
export function sameCssValue(a: string, b: string): boolean {
  if (normalize(a) === normalize(b)) return true;
  const colorA = parseCssColor(a);
  const colorB = parseCssColor(b);
  if (colorA && colorB) return sameColor(colorA, colorB);
  const shadowA = parseShadow(a);
  const shadowB = parseShadow(b);
  if (shadowA && shadowB && shadowA.length === shadowB.length) {
    return shadowA.every((layer, i) => {
      const other = shadowB[i]!;
      const lengths = (["offsetX", "offsetY", "blur", "spread"] as const).every((k) => layer[k].value === other[k].value);
      return lengths && sameColor(layer.color, other.color) && Boolean(layer.inset) === Boolean(other.inset);
    });
  }
  return false;
}

function prefixed(map: Map<string, { value: string }>, prefix: string): Map<string, string> {
  return new Map([...map].filter(([name]) => name.startsWith(`--${prefix}-`)).map(([name, d]) => [name, d.value]));
}

/** Compare `expectedCss` (the project's current file) with `builtCss` (generated tokens.css). */
export function compareParity(
  expectedCss: string,
  expectedBlocks: { light: BlockRef; dark?: BlockRef },
  builtCss: string,
  builtBlocks: { light: BlockRef; dark?: BlockRef },
  prefix: string,
): ParityReport {
  const different: ParityDifference[] = [];
  const missing: Array<{ variable: string; mode: "light" | "dark" }> = [];
  let matched = 0;
  const builtLight = prefixed(customProperties(builtCss, builtBlocks.light.selector, builtBlocks.light.outer), prefix);
  const builtDark = builtBlocks.dark ? prefixed(customProperties(builtCss, builtBlocks.dark.selector, builtBlocks.dark.outer), prefix) : new Map<string, string>();
  const modes: Array<["light" | "dark", BlockRef | undefined, Map<string, string>]> = [
    ["light", expectedBlocks.light, builtLight],
    ["dark", expectedBlocks.dark, new Map([...builtLight, ...builtDark])],
  ];
  for (const [mode, block, built] of modes) {
    if (!block) continue;
    const expected = prefixed(customProperties(expectedCss, block.selector, block.outer), prefix);
    for (const [variable, value] of expected) {
      const actual = built.get(variable);
      if (actual === undefined) missing.push({ variable, mode });
      else if (sameCssValue(value, actual)) matched++;
      else different.push({ variable, mode, expected: value, actual });
    }
  }
  const declared = prefixed(customProperties(expectedCss, expectedBlocks.light.selector, expectedBlocks.light.outer), prefix);
  const added = [...builtLight.keys()].filter((name) => !declared.has(name)).sort();
  return { matched, different, missing, added };
}

