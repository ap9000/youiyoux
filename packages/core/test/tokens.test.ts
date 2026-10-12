import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ComponentContract, jsonSchemaFor, TokenDocument, tokenValueProblems, validateTokenSets } from "../src/index.ts";

const REPO = join(import.meta.dirname, "../../..");
const DEMO_TOKENS = join(REPO, "examples/demo-design/tokens/demo");

const color = { colorSpace: "srgb", components: [0.31, 0.27, 0.9], hex: "#4f46e5" };
const px = (value: number) => ({ value, unit: "px" });

const file = (document: unknown, name = "motion.tokens.json") => ({ file: name, document });

describe("youi.tokens/v1 value types", () => {
  test("springs: stiffness, damping and mass, with an optional velocity", () => {
    expect(tokenValueProblems("spring", { stiffness: 400, damping: 30, mass: 1 })).toEqual([]);
    expect(tokenValueProblems("spring", { stiffness: 170, damping: 26, mass: 1, velocity: 0.5 })).toEqual([]);
    expect(tokenValueProblems("spring", "{motion.spring.snappy}")).toEqual([]);
    expect(tokenValueProblems("spring", { stiffness: 0, damping: 30, mass: 1 })).toEqual([expect.stringMatching(/^\$value\.stiffness: /)]);
    expect(tokenValueProblems("spring", { stiffness: 400, damping: -1, mass: 1 })).toEqual([expect.stringMatching(/^\$value\.damping: /)]);
    expect(tokenValueProblems("spring", { stiffness: 400, damping: 30 })).toEqual([expect.stringMatching(/^\$value\.mass: /)]);
    expect(tokenValueProblems("spring", [400, 30, 1])).not.toEqual([]);
  });

  test("focus rings: colour, width, offset and style; parts may alias", () => {
    expect(tokenValueProblems("focusRing", { color, width: px(2), offset: px(2), style: "solid" })).toEqual([]);
    expect(tokenValueProblems("focusRing", { color: "{color.accent}", width: "{size.ring}", offset: px(-1), style: "dashed" })).toEqual([]);
    expect(tokenValueProblems("focusRing", { color, width: px(2), offset: px(2), style: "wavy" })).toEqual([expect.stringMatching(/^\$value\.style: /)]);
    expect(tokenValueProblems("focusRing", { color: "#4f46e5", width: px(2), offset: px(2), style: "solid" })).toEqual([expect.stringMatching(/^\$value\.color: /)]);
    expect(tokenValueProblems("focusRing", { color, width: { value: 2, unit: "em" }, offset: px(2), style: "solid" })).toEqual([expect.stringMatching(/^\$value\.width\.unit: /)]);
  });

  test("durations, cubic béziers and transitions (DTCG 2025.10)", () => {
    expect(tokenValueProblems("duration", { value: 120, unit: "ms" })).toEqual([]);
    expect(tokenValueProblems("duration", { value: 0.2, unit: "s" })).toEqual([]);
    expect(tokenValueProblems("duration", { value: -5, unit: "ms" })).toEqual([expect.stringMatching(/^\$value\.value: /)]);
    expect(tokenValueProblems("duration", { value: 120, unit: "frames" })).toEqual([expect.stringMatching(/^\$value\.unit: /)]);
    expect(tokenValueProblems("duration", "120ms")).not.toEqual([]);
    expect(tokenValueProblems("cubicBezier", [0.2, 0.8, 0.2, 1])).toEqual([]);
    expect(tokenValueProblems("cubicBezier", [1.2, 0.8, 0.2, 1])).toEqual([expect.stringMatching(/^\$value\.0: /)]);
    expect(tokenValueProblems("transition", { duration: "{motion.duration.fast}", delay: { value: 0, unit: "ms" }, timingFunction: [0.2, 0.8, 0.2, 1] })).toEqual([]);
    expect(tokenValueProblems("transition", { duration: { value: 1, unit: "ms" }, timingFunction: [0.2, 0.8, 0.2, 1] })).toEqual([expect.stringMatching(/^\$value\.delay: /)]);
  });

  test("borders, strokes, shadows and typography", () => {
    expect(tokenValueProblems("border", { color: "{color.line}", width: px(1), style: "solid" })).toEqual([]);
    expect(tokenValueProblems("strokeStyle", { dashArray: [px(4), px(2)], lineCap: "round" })).toEqual([]);
    expect(tokenValueProblems("shadow", [{ color, offsetX: px(0), offsetY: px(1), blur: px(2), spread: px(0) }])).toEqual([]);
    expect(tokenValueProblems("typography", { fontFamily: "{font.sans}", fontSize: px(13), fontWeight: 500, lineHeight: 1.25 })).toEqual([]);
    expect(tokenValueProblems("typography", { fontFamily: "{font.sans}", fontSize: px(13), lineHeight: 1.25 })).toEqual([expect.stringMatching(/^\$value\.fontWeight: /)]);
    expect(tokenValueProblems("sparkle", 1)).toEqual([expect.stringContaining('unknown $type "sparkle"')]);
  });
});

/** The review's payload: a family that closes its quote and adds a declaration. */
const INJECTION = 'Geist"; --demo-color-accent: red; --x: "';

describe("font families cannot inject CSS", () => {
  test("letters, digits, spaces and hyphens per family; commas only between families in the string form", () => {
    for (const ok of ["Geist", "Inter, sans-serif", "Noto Sans JP", "游ゴシック", "{font.sans}"]) expect(tokenValueProblems("fontFamily", ok)).toEqual([]);
    expect(tokenValueProblems("fontFamily", ["Geist Variable", "ui-sans-serif", "-apple-system", "system-ui"])).toEqual([]);
    expect(tokenValueProblems("fontFamily", ["Inter, sans-serif"])).toEqual([expect.stringMatching(/^\$value\.0: a font family name may hold only/)]);
  });

  test("quotes, semicolons, braces, backslashes, angle brackets and control characters are refused, in the schema too", () => {
    const bad = [INJECTION, "Geist'", "Geist;", "Geist}", "Geist{", "Geist\\", "Geist<style>", "Geist\n", "Geist\u0000", "Geist\u007f", "Geist,", ",Geist", ""];
    for (const value of bad) {
      expect(tokenValueProblems("fontFamily", value), JSON.stringify(value)).toEqual([expect.stringContaining("a font family name may hold only letters, digits, spaces and hyphens")]);
      expect(tokenValueProblems("fontFamily", ["Geist", value]), JSON.stringify(value)).not.toEqual([]);
    }
    expect(tokenValueProblems("typography", { fontFamily: INJECTION, fontSize: px(13), fontWeight: 500, lineHeight: 1.25 })).toEqual([expect.stringMatching(/^\$value\.fontFamily: a font family name may hold only/)]);
    const document = { font: { sans: { $type: "fontFamily", $value: INJECTION } } };
    expect(TokenDocument.safeParse(document).success).toBe(false);
    expect(TokenDocument.safeParse({ font: { sans: { $type: "fontFamily", $value: ["Geist", "sans-serif"] } } }).success).toBe(true);
    expect(validateTokenSets([file(document)])).toEqual([expect.stringMatching(/^motion\.tokens\.json: font\.sans: \$value: a font family name/)]);
    // The published JSON Schema carries the same rule, so editors refuse the payload as it is typed.
    const pattern = /"pattern":"([^"]*p\{L\}[^"]*)"/.exec(JSON.stringify(jsonSchemaFor("youi.tokens.schema.json")))![1]!;
    const regex = new RegExp(JSON.parse(`"${pattern}"`) as string, "u");
    expect(regex.test("Inter, sans-serif")).toBe(true);
    expect(regex.test(INJECTION)).toBe(false);
  });

  test("token and group names become CSS variable names, so they may not hold punctuation", () => {
    const names = file({ color: { $type: "color", "accent;--x:red": { $value: color }, "brand blue": { $value: color }, accent_2: { $value: color }, "ink-2": { $value: color } } });
    expect(validateTokenSets([names])).toEqual([
      "motion.tokens.json: color.accent;--x:red: a token or group name becomes a CSS variable name, so it may hold only letters, digits, hyphens and underscores",
      "motion.tokens.json: color.brand blue: a token or group name becomes a CSS variable name, so it may hold only letters, digits, hyphens and underscores",
    ]);
  });
});

describe("validateTokenSets", () => {
  test("names the file and token path, checks aliases resolve to the same type, and finds cycles", () => {
    const base = file({
      motion: {
        spring: { $type: "spring", snappy: { $value: { stiffness: 400, damping: 30, mass: 1 } }, broken: { $value: { stiffness: -1, damping: 30, mass: 1 } } },
        duration: { fast: { $type: "duration", $value: { value: 120, unit: "ms" } } },
      },
      focus: { ring: { $type: "focusRing", $value: { color: "{color.nope}", width: px(2), offset: px(2), style: "solid" } } },
      a: { $type: "duration", $value: "{b}" },
      b: { $type: "duration", $value: "{a}" },
      wrong: { $type: "spring", $value: "{motion.duration.fast}" },
    });
    expect(validateTokenSets([base])).toEqual([
      expect.stringMatching(/^motion\.tokens\.json: motion\.spring\.broken: \$value\.stiffness: /),
      "motion.tokens.json: focus.ring: alias {color.nope} names no token",
      "motion.tokens.json: wrong: alias {motion.duration.fast} is a duration, not a spring",
      "alias cycle: a → b → a",
    ]);
  });

  test("the demo system, its dark set and the hub's own tokens are valid", async () => {
    const read = async (path: string) => file(JSON.parse(await readFile(path, "utf8")), path);
    const demo = [await read(join(DEMO_TOKENS, "demo.tokens.json")), await read(join(DEMO_TOKENS, "demo.dark.tokens.json"))];
    expect(validateTokenSets(demo)).toEqual([]);
    for (const source of demo) expect(TokenDocument.safeParse(source.document).success).toBe(true);
    const hub = [await read(join(REPO, "apps/web/design/youiyoux.tokens.json")), await read(join(REPO, "apps/web/design/youiyoux.dark.tokens.json"))];
    expect(validateTokenSets(hub)).toEqual([]);
  });

  test("the published schema describes springs and focus rings as first-class types", () => {
    const text = JSON.stringify(jsonSchemaFor("youi.tokens.schema.json"));
    for (const type of ["spring", "focusRing", "duration", "cubicBezier", "transition", "border", "strokeStyle", "shadow", "typography"]) expect(text).toContain(`"const":"${type}"`);
    expect(text).toContain('"stiffness"');
    expect(text).toContain('"offset"');
  });
});

describe("component states", () => {
  const contract = {
    schema: "youi.component/v1",
    id: "youi:demo/component/chip",
    name: "Chip",
    version: "1.0.0",
    status: "beta",
    summary: "A chip.",
    source: { file: "chip/chip.tsx", export: "Chip" },
    platforms: ["web"],
    props: {},
  };

  test("bind tokens per interaction state and role", () => {
    const parsed = ComponentContract.parse({ ...contract, states: { hover: { "bg.default": "youi:demo/token/color.accent-hover" }, focus: { ring: "youi:demo/token/focus.ring" } } });
    expect(parsed.states?.hover).toEqual({ "bg.default": "youi:demo/token/color.accent-hover" });
    expect(ComponentContract.parse(contract).states).toBeUndefined();
  });

  test("refuse unknown states and roles that cannot name a CSS variable", () => {
    expect(ComponentContract.safeParse({ ...contract, states: { pressed: { bg: "youi:demo/token/color.accent" } } }).success).toBe(false);
    expect(ComponentContract.safeParse({ ...contract, states: { hover: { "Bg Default": "youi:demo/token/color.accent" } } }).success).toBe(false);
    expect(ComponentContract.safeParse({ ...contract, states: { hover: { bg: "color.accent" } } }).success).toBe(false);
  });
});
