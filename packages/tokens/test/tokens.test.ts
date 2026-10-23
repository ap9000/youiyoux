import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefinitionError, FONT_FAMILY_NAME, loadDesignRepo, OutputConfig } from "@youiyoux/core";
import { describe, expect, test } from "vitest";
import { buildTokens, compareParity, contrastRatio, contrastText, cssComment, cssString, cssValue, formatCssColor, FAMILY_NAME, sameColor, toHex, generatedHeader, importTokens, isLargeText, parseCssColor, parseShadow, readRules, resolverLayout, sameCssValue, springCurve, systemPairs, gradePairs, tokenVariables } from "../src/index.ts";

const DEMO = join(import.meta.dirname, "../../../examples/demo-design");
const demoOutput = OutputConfig.parse({
  cssVarPrefix: "demo",
  dark: [{ media: "(prefers-color-scheme: dark)", selector: ":root:not([data-theme=\"light\"])" }, { selector: ":root[data-theme=\"dark\"]" }],
  targets: ["css-vars", "tailwind-v4", "ts", "react-native"],
  tailwind: { includeAll: true, map: { "color-primary": "color.accent", "radius-xl": "16px" } },
});

describe("colour", () => {
  test("parses hex, rgb and translucent rgb, and prints the shortest exact form", () => {
    expect(parseCssColor("#FFF")).toMatchObject({ components: [1, 1, 1], hex: "#ffffff" });
    const soft = parseCssColor("rgb(255 151 125 / .12)")!;
    expect(soft.alpha).toBe(0.12);
    expect(formatCssColor(soft)).toBe("rgb(255 151 125 / .12)");
    expect(formatCssColor(parseCssColor("rgba(0, 0, 0, 0.5)")!)).toBe("rgb(0 0 0 / .5)");
    expect(parseCssColor("var(--x)")).toBeNull();
  });

  test("reads oklch() as Tailwind v4 and shadcn/ui write it, keeps it exactly, and compares and grades it by its sRGB value", () => {
    const primary = parseCssColor("oklch(0.205 0 0)")!;
    expect(primary).toEqual({ colorSpace: "oklch", components: [0.205, 0, 0], hex: "#171717" });
    expect(formatCssColor(primary)).toBe("oklch(0.205 0 0)");
    expect(formatCssColor(parseCssColor("oklch(1 0 0 / 10%)")!)).toBe("oklch(1 0 0 / .1)");
    expect(parseCssColor("oklch(62.8% 0.2577 29.23deg)")!.components).toEqual([0.628, 0.2577, 29.23]);
    // Tailwind's red-500 is #fb2c36 in sRGB.
    expect(toHex(parseCssColor("oklch(0.637 0.237 25.331)")!)).toBe("#fb2c36");
    expect(sameColor(parseCssColor("oklch(0.985 0 0)")!, parseCssColor("#fafafa")!)).toBe(true);
    expect(sameColor(parseCssColor("oklch(0.985 0 0)")!, parseCssColor("#ffffff")!)).toBe(false);
    expect(contrastRatio("oklch(0.145 0 0)", "oklch(1 0 0)")).toBeCloseTo(contrastRatio("#0a0a0a", "#ffffff")!, 2);
  });

  test("reads hsl() into sRGB; a bare `210 40% 98%` is not a colour (it is only one inside hsl(var(--x)))", () => {
    expect(parseCssColor("hsl(0 100% 50%)")).toMatchObject({ colorSpace: "srgb", hex: "#ff0000" });
    expect(toHex(parseCssColor("hsl(210, 40%, 98%)")!)).toBe("#f8fafc");
    expect(parseCssColor("hsl(0 0% 0% / .5)")!.alpha).toBe(0.5);
    expect(parseCssColor("210 40% 98%")).toBeNull();
  });

  test("shadows parse layer by layer and compare across formatting", () => {
    expect(parseShadow("0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .04)")).toHaveLength(2);
    expect(sameCssValue("0 1px 2px rgb(0 0 0 / .06)", "0px 1px 2px 0px rgb(0 0 0 / .06)")).toBe(true);
    expect(sameCssValue("#fff", "#ffffff")).toBe(true);
    expect(sameCssValue("#fff", "#fffffe")).toBe(false);
  });
});

describe("css reader", () => {
  test("separates nested blocks and keeps line numbers", () => {
    const css = ":root {\n  --a: #fff;\n}\n@media (prefers-color-scheme: dark) {\n  :root { --a: #000; }\n}\n.x { color: red; }\n";
    const rules = readRules(css);
    expect(rules.map((r) => r.preludes.join(" > "))).toEqual([":root", "@media (prefers-color-scheme: dark) > :root", ".x"]);
    expect(rules[1]!.declarations[0]).toMatchObject({ property: "--a", value: "#000", line: 5 });
  });
});

describe("import", () => {
  test("CSS values win over DESIGN.md, and disagreements and gaps are reported", () => {
    const designMd = "---\ncolors:\n  ink: \"#171717\"\n  ink-dark: \"#eeeeee\"\n  ghost: \"#123456\"\n---\n\n- **Ink** (ink, #171717 / #ededed): all body text.\n";
    const css = ":root { --app-ink: #171717; --app-act: var(--app-ink); --app-sheet-shadow: 0 1px 2px rgb(0 0 0 / .1); }\n:root[data-theme=\"dark\"] { --app-ink: #ededed; }\n";
    const { base, dark, report } = importTokens({ designMd, css: { css, prefix: "app", light: { selector: ":root" }, dark: { selector: ":root[data-theme=\"dark\"]" } }, paths: { "sheet-shadow": "shadow.sheet" } });
    expect(report.mismatches).toEqual([{ name: "ink", mode: "dark", designMd: "#eeeeee", css: "#ededed" }]);
    expect(report.documentedOnly).toEqual(["ghost"]);
    expect(report.undocumented).toEqual(["act", "sheet-shadow"]);
    expect((base.color as Record<string, { $value: unknown; $description?: string }>).act!.$value).toBe("{color.ink}");
    expect((base.color as Record<string, { $description?: string }>).ink!.$description).toBe("Ink: all body text.");
    expect(Object.keys(dark.color as object)).toEqual(["ink"]);
  });
});

describe("build", () => {
  test("the demo system builds all four targets from the DTCG resolver", async () => {
    const repo = await loadDesignRepo(DEMO);
    const built = await buildTokens(DEMO, repo.systems[0]!.config, demoOutput);
    expect(built.tokens.length).toBe(29);
    expect(built.files.map((f) => f.path)).toEqual(["tokens.css", "theme.css", "tokens.ts", "tokens.native.ts"]);
    for (const file of built.files) expect(file.content).toMatch(/@generated by youi/);
    const css = built.files[0]!.content;
    expect(css).toContain("--demo-color-foreground: #1c1c21;");
    expect(css).toContain("--demo-color-danger-soft: rgb(198 40 40 / .1);");
    expect(css).toContain("--demo-color-accent: var(--demo-color-brand);");
    const theme = built.files[1]!.content;
    expect(theme).toContain("--color-primary: var(--demo-color-accent);");
    expect(theme).toContain("--radius-xl: 16px;");
    expect(theme).toContain("--text-label: var(--demo-typography-label-font-size);");
    // Tailwind's own names are never overridden by includeAll (only by an explicit map entry).
    expect(theme).not.toContain("--spacing-md:");
    expect(theme).not.toContain("--ease-out:");
    expect(theme).not.toContain("--font-sans:");
    expect(theme).toContain("--radius-card: var(--demo-radius-card);");
    const native = built.files[3]!.content;
    expect(native).toContain("\"radius.control\": 8,");
  });

  test("the build reproduces every variable a project ships (parity, light and dark)", async () => {
    const repo = await loadDesignRepo(DEMO);
    const built = await buildTokens(DEMO, repo.systems[0]!.config, demoOutput);
    const css = built.files[0]!.content;
    // A product's hand-written token blocks, written differently from the build (short hex, unpadded shadows).
    const shipped = [
      ":root { --demo-color-foreground: #1c1c21; --demo-color-background: #fff; --demo-color-accent: var(--demo-color-brand); --demo-shadow-card: 0 1px 2px rgb(0 0 0 / .06); --demo-color-danger-soft: rgb(198 40 40 / .1); }",
      ":root[data-theme=\"dark\"] { --demo-color-foreground: #ececf1; --demo-color-background: #121214; --demo-color-danger-soft: rgb(255 138 128 / .14); --demo-shadow-card: 0 1px 2px rgb(0 0 0 / .4); }",
    ].join("\n");
    const blocks = { light: { selector: ":root" }, dark: { selector: ":root[data-theme=\"dark\"]" } };
    const report = compareParity(shipped, blocks, css, blocks, "demo");
    expect(report.different).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.matched).toBe(9);
  });
});

describe("motion and focus (youi types)", () => {
  test("a spring settles from 0 to 1; less damping overshoots and takes longer", () => {
    const snappy = springCurve({ stiffness: 400, damping: 40, mass: 1 });
    const gentle = springCurve({ stiffness: 170, damping: 18, mass: 1 });
    expect(snappy.settles).toBe(true);
    expect(snappy.points[0]).toBe(0);
    expect(snappy.points.at(-1)).toBe(1);
    expect(Math.max(...snappy.points)).toBeLessThanOrEqual(1);
    expect(Math.max(...gentle.points)).toBeGreaterThan(1.02);
    expect(gentle.durationMs).toBeGreaterThan(snappy.durationMs);
    expect(springCurve({ stiffness: 100, damping: 0, mass: 1 }).settles).toBe(false);
  });

  test("springs and focus rings become variables; alias parts stay var() references", () => {
    const ref = (path: string, suffix = "") => `var(--x-${path.replace(/\./g, "-")}${suffix})`;
    const ring = tokenVariables("focusRing", { color: "{color.accent}", width: { value: 2, unit: "px" }, offset: { value: 2, unit: "px" }, style: "solid" }, ref);
    expect(ring).toEqual([
      ["", "2px solid var(--x-color-accent)"],
      ["-color", "var(--x-color-accent)"],
      ["-width", "2px"],
      ["-offset", "2px"],
      ["-style", "solid"],
    ]);
    const spring = tokenVariables("spring", { stiffness: 400, damping: 40, mass: 1 });
    expect(spring.map(([suffix]) => suffix)).toEqual(["", "-duration", "-stiffness", "-damping", "-mass"]);
    expect(spring[0]![1]).toMatch(/^linear\(0, .*, 1\)$/);
    expect(tokenVariables("spring", "{motion.spring.snappy}", ref)[1]).toEqual(["-duration", "var(--x-motion-spring-snappy-duration)"]);
    expect(cssValue("duration", { value: 0.2, unit: "s" })).toBe("0.2s");
    expect(cssValue("border", { color: { colorSpace: "srgb", components: [0, 0, 0] }, width: { value: 1, unit: "px" }, style: "dashed" })).toBe("1px dashed #000000");
  });

  test("the build lowers springs and focus rings to every target, and emits component state variables", async () => {
    const repo = await loadDesignRepo(DEMO);
    const system = repo.systems[0]!;
    const built = await buildTokens(DEMO, system.config, demoOutput, { contracts: system.components.map((c) => c.contract) });
    const [css, theme, ts, native] = built.files.map((f) => f.content) as [string, string, string, string];
    expect(css).toContain("--demo-focus-ring: 2px solid var(--demo-color-accent);");
    expect(css).toContain("--demo-focus-ring-offset: 2px;");
    expect(css).toMatch(/--demo-motion-spring-snappy: linear\(0, [^;]+, 1\);/);
    expect(css).toMatch(/--demo-motion-spring-snappy-duration: \d+ms;/);
    expect(css).toContain("--demo-motion-duration-fast: 120ms;");
    expect(css).toContain("--demo-motion-control: var(--demo-motion-duration-fast) 0ms var(--demo-easing-out);");
    expect(css).toContain("--demo-button-hover-bg-default: var(--demo-color-accent-hover);");
    expect(css).toContain("--demo-button-focus-ring-offset: var(--demo-focus-ring-offset);");
    expect(css).toContain("--demo-input-disabled-opacity: var(--demo-opacity-disabled);");
    expect(theme).toContain("--ease-spring-snappy: var(--demo-motion-spring-snappy);");
    expect(theme).toContain("--transition-duration-spring-snappy: var(--demo-motion-spring-snappy-duration);");
    expect(theme).toContain("--transition-duration-fast: var(--demo-motion-duration-fast);");
    expect(theme).toContain("--color-focus-ring: var(--demo-focus-ring-color);");
    expect(ts).toContain('"focus.ring": "2px solid #4f46e5",');
    expect(native).toMatch(/"motion\.spring\.snappy": \{"stiffness":400,"damping":40,"mass":1,"durationMs":\d+\}/);
    expect(native).toContain('"motion.duration.fast": 120,');
    // The focus ring follows the accent into dark through its alias.
    expect(built.tokens.find((t) => t.id === "focus.ring")).toMatchObject({ dependsOn: ["color.accent"], source: { light: { color: "{color.accent}" } }, dark: { color: { hex: "#8c85ff" } } });
    // Without contracts there are no state variables.
    expect((await buildTokens(DEMO, system.config, demoOutput)).files[0]!.content).not.toContain("--demo-button-");
  });

  test("an oklch() colour builds to the same oklch() in light and dark", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-tokens-"));
    try {
      await cp(DEMO, dir, { recursive: true });
      for (const [name, value] of [["demo.tokens.json", "oklch(0.205 0 0)"], ["demo.dark.tokens.json", "oklch(0.922 0 0 / 80%)"]] as const) {
        const file = join(dir, "tokens/demo", name);
        const tokens = JSON.parse(await readFile(file, "utf8")) as { color: Record<string, { $type?: string; $value: unknown }> };
        tokens.color.accent = { $type: "color", ...tokens.color.accent, $value: parseCssColor(value) };
        await writeFile(file, JSON.stringify(tokens, null, 2));
      }
      const repo = await loadDesignRepo(dir);
      const built = await buildTokens(dir, repo.systems[0]!.config, demoOutput);
      const css = built.files.find((f) => f.path === "tokens.css")!.content;
      expect(css).toContain("--demo-color-accent: oklch(0.205 0 0);");
      expect(css).toContain("--demo-color-accent: oklch(0.922 0 0 / .8);");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed spring stops the build, naming the file and the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-tokens-"));
    try {
      await cp(DEMO, dir, { recursive: true });
      const file = join(dir, "tokens/demo/demo.tokens.json");
      const tokens = JSON.parse(await readFile(file, "utf8")) as { motion: { spring: { snappy: { $value: { stiffness: number } } } } };
      tokens.motion.spring.snappy.$value.stiffness = -400;
      await writeFile(file, JSON.stringify(tokens, null, 2));
      const repo = await loadDesignRepo(dir);
      const failure = await buildTokens(dir, repo.systems[0]!.config, demoOutput).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DefinitionError);
      expect((failure as DefinitionError).issues).toEqual([expect.stringMatching(/^tokens\/demo\/demo\.tokens\.json: motion\.spring\.snappy: \$value\.stiffness: /)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the resolver layout names the base set and each theme context's files", async () => {
    const resolver = JSON.parse(await readFile(join(DEMO, "tokens/demo/demo.resolver.json"), "utf8")) as unknown;
    expect(resolverLayout(resolver, { name: "theme", light: "light", dark: "dark" })).toEqual({ base: ["demo.tokens.json"], contexts: { light: [], dark: ["demo.dark.tokens.json"] }, files: ["demo.tokens.json", "demo.dark.tokens.json"], inline: 0 });
  });
});

/** The review's payload: a family that closes its quote and adds a declaration. */
const INJECTION = 'Geist"; --demo-color-accent: red; --x: "';

/** A CSS value with its strings and comments removed, as a CSS tokenizer sees it; throws on an unclosed string or comment. */
function outsideStrings(css: string): string {
  let out = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`unclosed comment in ${css}`);
      i = end + 1;
      out += " ";
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < css.length && css[j] !== c; j++) {
        if (css[j] === "\\") j++;
        else if (css[j] === "\n") throw new Error(`newline in a string in ${css}`);
      }
      if (j >= css.length) throw new Error(`unclosed string in ${css}`);
      i = j;
      out += '""';
    } else out += c;
  }
  return out;
}

/** Copy the demo design repo, change its token file, and build it. */
async function buildEdited(edit: (tokens: Record<string, Record<string, Record<string, unknown>>>) => void, system: (config: { name: string }) => void = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), "youi-tokens-"));
  try {
    await cp(DEMO, dir, { recursive: true });
    const file = join(dir, "tokens/demo/demo.tokens.json");
    const tokens = JSON.parse(await readFile(file, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    edit(tokens);
    await writeFile(file, JSON.stringify(tokens, null, 2));
    const repo = await loadDesignRepo(dir);
    const config = structuredClone(repo.systems[0]!.config);
    system(config);
    return await buildTokens(dir, config, demoOutput).catch((error: unknown) => error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CSS injection", () => {
  test("family names are escaped in every value that writes them, so the payload stays one string", () => {
    expect(cssValue("fontFamily", INJECTION)).toBe('"Geist\\"; --demo-color-accent: red; --x: \\""');
    expect(cssValue("fontFamily", ["Geist", "ui-sans-serif", "Geist Mono"])).toBe('Geist, ui-sans-serif, "Geist Mono"');
    for (const name of [INJECTION, "a\\\"; b", "a\nb: red; c", "a</style><script>", "a}b{c", "a\u0000b"]) {
      const css = cssValue("fontFamily", ["Geist", name]);
      expect(outsideStrings(css), JSON.stringify(name)).toBe('Geist, ""');
    }
    expect(cssString("a\nb")).toBe('"a\\a b"');
    // The editor checks names with the same rule as the token schema, before a value is applied.
    expect(FAMILY_NAME.source).toBe(FONT_FAMILY_NAME.source);
    expect(FAMILY_NAME.flags).toBe(FONT_FAMILY_NAME.flags);
    const typography = { fontFamily: [INJECTION], fontSize: { value: 13, unit: "px" }, fontWeight: 500, lineHeight: 1.25 };
    expect(outsideStrings(cssValue("typography", typography))).toBe('500 13px/1.25 ""');
    for (const [suffix, css] of tokenVariables("typography", typography)) expect(outsideStrings(css), suffix).not.toMatch(/[;{}]/);
  });

  test("comments cannot be closed by a description or a system name", () => {
    expect(cssComment("a */ --x: red; /* b")).toBe("a *\\/ --x: red; /* b");
    expect(outsideStrings(`/* ${cssComment("a */ --x: red; /* b\n*/")} */`)).toBe(" ");
    const header = generatedHeader({ name: "Demo */ :root { --x: red } /*\n", version: "1.0.0" } as Parameters<typeof generatedHeader>[0], "css");
    expect(outsideStrings(header).trim()).toBe("");
    expect(generatedHeader({ name: "Demo\nexport const x = 1;", version: "1.0.0" } as Parameters<typeof generatedHeader>[0], "ts")).not.toContain("\n");
  });

  test("the build refuses the payload in a font family, a token name or a css name override", async () => {
    const family = await buildEdited((t) => {
      t.font!.sans!.$value = INJECTION;
    });
    expect(family).toBeInstanceOf(DefinitionError);
    expect((family as DefinitionError).issues).toEqual([expect.stringMatching(/^tokens\/demo\/demo\.tokens\.json: font\.sans: \$value: a font family name may hold only/)]);
    const named = await buildEdited((t) => {
      t.color!["accent;--x:red"] = t.color!.accent!;
    });
    expect((named as DefinitionError).issues).toEqual([expect.stringContaining("color.accent;--x:red: a token or group name becomes a CSS variable name")]);
    const override = await buildEdited((t) => {
      t.color!.accent!.$extensions = { "dev.youiyoux": { css: "accent; --evil: 1" } };
    });
    expect(override).toBeInstanceOf(DefinitionError);
    expect((override as DefinitionError).issues).toEqual(['color.accent: its CSS variable name "accent; --evil: 1" may hold only letters, digits, hyphens and underscores']);
  });

  test("a description that closes its comment adds no declaration to tokens.css", async () => {
    const built = await buildEdited(
      (t) => {
        t.color!.background!.$description = "Bg */ --demo-color-accent: red; /* x";
      },
      (config) => {
        config.name = "Demo */ :root { --demo-color-accent: red } /*";
      },
    );
    const css = (built as Awaited<ReturnType<typeof buildTokens>>).files.find((f) => f.path === "tokens.css")!.content;
    expect(css).toContain("/* Bg *\\/ --demo-color-accent: red; /* x */");
    expect(outsideStrings(css)).not.toContain("red");
    for (const file of (built as Awaited<ReturnType<typeof buildTokens>>).files.filter((f) => f.path.endsWith(".css"))) expect(() => outsideStrings(file.content)).not.toThrow();
  });

  test("the other free values that reach CSS are typed: stroke and ring styles, transitions and shadow colours", () => {
    // Line styles are an enum in the schema; the emitter writes a known style or "solid", never the text it was given.
    expect(cssValue("strokeStyle", "dashed; --x: red")).toBe("solid");
    expect(cssValue("border", { color: { colorSpace: "srgb", components: [0, 0, 0] }, width: { value: 1, unit: "px" }, style: "solid;--x:red" })).toBe("1px solid #000000");
    expect(cssValue("focusRing", { color: { colorSpace: "srgb", components: [0, 0, 0] }, width: { value: 2, unit: "px" }, offset: { value: 2, unit: "px" }, style: "solid}" })).toBe("2px solid #000000");
    // Numbers and units only: a shadow colour is written from its components, a transition from durations and a bézier.
    expect(cssValue("shadow", { color: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5, hex: "#000000" }, offsetX: { value: 0, unit: "px" }, offsetY: { value: 1, unit: "px" }, blur: { value: 2, unit: "px" }, spread: { value: 0, unit: "px" } })).toBe("0px 1px 2px 0px rgb(0 0 0 / .5)");
    expect(cssValue("transition", { duration: { value: 120, unit: "ms" }, delay: { value: 0, unit: "ms" }, timingFunction: [0.2, 0, 0, 1] })).toBe("120ms 0ms cubic-bezier(0.2, 0, 0, 1)");
  });
});

describe("contrast pairs", () => {
  const tokens = [
    { path: "color.background", type: "color", light: "#ffffff", dark: "#121214" },
    { path: "color.card", type: "color", light: "#f7f7f8", dark: "#1b1b1f" },
    { path: "color.foreground", type: "color", light: "#1c1c21", dark: "#ececf1" },
    { path: "color.muted", type: "color", light: "#c4c4cc", dark: "#9f9fab" },
    { path: "color.accent", type: "color", light: "#4f46e5", dark: "#8c85ff" },
    { path: "color.on-accent", type: "color", light: "#ffffff", dark: "#14123a" },
  ];

  test("a light grey muted on card fails AA in light only; the rest pass", () => {
    const findings = gradePairs(systemPairs(tokens), tokens);
    const failing = findings.filter((f) => !f.passes).map((f) => `${f.pair.label} ${f.scheme} ${f.grade}`);
    expect(failing).toEqual(["color.muted on color.background light Fail", "color.muted on color.card light Fail"]);
    expect(findings.find((f) => f.pair.foreground === "color.on-accent" && f.scheme === "light")).toMatchObject({ passes: true, grade: "AA", required: 4.5 });
  });

  test("a -soft colour without a base colour is not read as text", () => {
    const orphan = [...tokens, { path: "color.neutral-soft", type: "color", light: "#f0f0f0", dark: "#222222" }];
    expect(systemPairs(orphan).some((p) => p.foreground === "color.neutral-soft" || p.background === "color.neutral-soft")).toBe(false);
  });

  test("a translucent fill is composited over the scheme's surface, not white", () => {
    const soft = [...tokens, { path: "color.danger", type: "color", light: "#c62828", dark: "#ff8a80" }, { path: "color.danger-soft", type: "color", light: "rgb(198 40 40 / .1)", dark: "rgb(255 138 128 / .14)" }];
    const dark = gradePairs(systemPairs(soft), soft).find((f) => f.pair.background === "color.danger-soft" && f.scheme === "dark")!;
    expect(dark.passes).toBe(true);
    expect(dark.ratio!).toBeGreaterThan(4.5);
  });

  test("contract fg/bg roles pair per variant and per state; focus rings need 3:1 on surfaces", () => {
    const contract = { id: "youi:demo/component/button", name: "Button", tokens: { "bg.default": "youi:demo/token/color.accent", "fg.default": "youi:demo/token/color.on-accent" }, states: { hover: { "bg.default": "youi:demo/token/color.muted" } } };
    const pairs = systemPairs(tokens, [contract], { focusRings: new Map([["focus.ring", { color: "color.accent", offset: 2 }]]) });
    expect(pairs.filter((p) => p.source === "contract").map((p) => [p.label, p.foreground, p.background])).toEqual([
      ["Button default: text on fill", "color.on-accent", "color.accent"],
      ["Button default (hover): text on fill", "color.on-accent", "color.muted"],
    ]);
    const hover = gradePairs(pairs, tokens).find((f) => f.pair.state === "hover" && f.scheme === "light")!;
    expect(hover.passes).toBe(false);
    // A ring at a 2px offset sits on the surface around the button, not on its fill.
    expect(pairs.filter((p) => p.source === "focus").map((p) => [p.kind, p.background])).toEqual([["ui", "color.background"], ["ui", "color.card"]]);
  });

  test("a focus ring drawn over its element is checked against the fills of the contracts it focuses, state fills included", () => {
    const ring = [...tokens, { path: "color.ring", type: "color", light: "#5b54e8", dark: "#8c85ff" }, { path: "color.card-hover", type: "color", light: "#e6e6ee", dark: "#2a2a30" }];
    const button = { id: "youi:demo/component/button", name: "Button", tokens: { "bg.default": "youi:demo/token/color.accent", "fg.default": "youi:demo/token/color.on-accent" }, states: { focus: { ring: "youi:demo/token/focus.ring" } } };
    const card = { id: "youi:demo/component/card", name: "Card", tokens: { bg: "youi:demo/token/color.card" }, states: { hover: { bg: "youi:demo/token/color.card-hover" } } };
    const inside = systemPairs(ring, [button, card], { focusRings: new Map([["focus.ring", { color: "color.ring", offset: 0 }]]) });
    const onFills = inside.filter((p) => p.source === "focus" && p.contract);
    expect(onFills.map((p) => [p.label, p.background, p.kind])).toEqual([
      ["focus.ring (color.ring) on Button bg.default", "color.accent", "ui"],
      ["focus.ring (color.ring) on Card bg", "color.card", "ui"],
      ["focus.ring (color.ring) on Card bg (hover)", "color.card-hover", "ui"],
    ]);
    // An indigo ring on an indigo fill is invisible: 1.1:1 against the 3:1 a UI part needs.
    const graded = gradePairs(onFills, ring).find((f) => f.pair.background === "color.accent" && f.scheme === "light")!;
    expect(graded).toMatchObject({ passes: false, required: 3, grade: "Fail" });
    expect(graded.ratio!).toBeLessThan(1.5);
    // At a positive offset the same ring sits on the surface around the element: surfaces only.
    expect(systemPairs(ring, [button, card], { focusRings: new Map([["focus.ring", { color: "color.ring", offset: 2 }]]) }).some((p) => p.source === "focus" && p.contract)).toBe(false);
  });

  test("large text needs 3:1: contracts set only in large type, and heading colours linked to large typography by name", () => {
    const grey = [...tokens, { path: "color.heading", type: "color", light: "#8a8a94", dark: "#9f9fab" }, { path: "color.subtle", type: "color", light: "#8a8a94", dark: "#9f9fab" }];
    const typography = [contrastText("typography.heading", { fontSize: { value: 28, unit: "px" }, fontWeight: 600 }), contrastText("typography.label", { fontSize: { value: 1.25, unit: "rem" }, fontWeight: "bold" }), contrastText("typography.body", { fontSize: { value: 14, unit: "px" }, fontWeight: 400 })];
    expect(typography.map(isLargeText)).toEqual([true, true, false]);
    expect(isLargeText({ size: 20, weight: 600 })).toBe(false);
    const pairs = systemPairs(grey, [], { typography });
    const heading = pairs.filter((p) => p.foreground === "color.heading");
    expect(heading.map((p) => [p.kind, p.source, p.background])).toEqual([["large", "large", "color.background"], ["large", "large", "color.card"]]);
    // #8a8a94 on white is 3.4:1: enough for a heading, not for body text in the same grey.
    const findings = gradePairs(pairs, grey).filter((f) => f.scheme === "light" && f.pair.background === "color.background");
    expect(findings.find((f) => f.pair.foreground === "color.heading")).toMatchObject({ passes: true, required: 3, grade: "AA large" });
    expect(findings.find((f) => f.pair.foreground === "color.subtle")).toMatchObject({ passes: false, required: 4.5 });
    // Without large typography of that name, a heading colour is not read as large text.
    expect(systemPairs(grey, [], { typography: typography.slice(2) }).some((p) => p.kind === "large")).toBe(false);

    const badge = { id: "youi:demo/component/badge", name: "Badge", tokens: { "bg.default": "youi:demo/token/color.card", "fg.default": "youi:demo/token/color.subtle", text: "youi:demo/token/typography.label" } };
    const body = { ...badge, id: "youi:demo/component/chip", name: "Chip", tokens: { ...badge.tokens, text: "youi:demo/token/typography.body" } };
    const contracts = systemPairs(grey, [badge, body], { typography }).filter((p) => p.source === "contract");
    expect(contracts.map((p) => [p.label, p.kind])).toEqual([["Badge default: large text on fill", "large"], ["Chip default: text on fill", "text"]]);
  });

  test("a colour that cannot be read fails, with the reason, instead of passing", () => {
    const unread = tokens.map((t) => (t.path === "color.muted" ? { ...t, light: "var(--somewhere)", dark: "color(display-p3 0.5 0.5 0.5)" } : t));
    const findings = gradePairs(systemPairs(unread), unread).filter((f) => f.pair.foreground === "color.muted");
    expect(findings.length).toBe(4);
    for (const finding of findings) expect(finding).toMatchObject({ passes: false, ratio: null, grade: null, unreadable: expect.stringMatching(/^could not read colour color\.muted \((light: var\(--somewhere\)|dark: color\(display-p3 0\.5 0\.5 0\.5\))\)$/) });
    expect(findings.every((f) => !f.passes)).toBe(true);
  });
});
