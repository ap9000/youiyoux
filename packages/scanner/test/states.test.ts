import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { forcedStates, newStats, projectSpecimens, SpecimenCache, STATE_CLASSES, STATES_MARKER } from "../src/index.ts";

/** The rewritten sheet without its marker, for comparing rules. */
const twins = (css: string): string => forcedStates(css).replace(`\n${STATES_MARKER}\n`, "");
/** Whitespace runs as one space. */
const flat = (css: string): string => css.replace(/\s+/g, " ");
const is = (original: string, state: keyof typeof STATE_CLASSES): string => `:is(${original}, .${STATE_CLASSES[state]}, .${STATE_CLASSES[state]} *)`;

describe("forced-state twins: each pseudo-class and attribute (c1)", () => {
  test.each([
    [":hover", "hover"],
    [":focus-visible", "focus"],
    [":focus", "focus"],
    [":focus-within", "focus"],
    [":active", "active"],
    [":disabled", "disabled"],
    ["[disabled]", "disabled"],
    ['[aria-disabled="true"]', "disabled"],
    ["[aria-disabled=true]", "disabled"],
  ] as const)("%s also matches .youi-state-%s, at the same specificity", (pseudo, state) => {
    expect(twins(`.b${pseudo} { color: red; }`)).toBe(`.b${is(pseudo, state)} { color: red; }`);
  });

  test("Tailwind v4's flat output: escaped class names keep their colons", () => {
    expect(twins(".focus-visible\\:ring-2:focus-visible{--tw-ring:1}.disabled\\:opacity-50:disabled{opacity:.5}.aria-disabled\\:x[aria-disabled=\"true\"]{opacity:.5}.active\\:scale-95:active{scale:.95}")).toBe(
      `.focus-visible\\:ring-2${is(":focus-visible", "focus")}{--tw-ring:1}.disabled\\:opacity-50${is(":disabled", "disabled")}{opacity:.5}.aria-disabled\\:x${is('[aria-disabled="true"]', "disabled")}{opacity:.5}.active\\:scale-95${is(":active", "active")}{scale:.95}`,
    );
  });

  test("Tailwind v4's nested output: `&:hover` blocks inside a rule, and `@media (hover: hover)` inside those", () => {
    const out = flat(twins(".hover\\:bg-accent { &:hover { @media (hover: hover) { background-color: var(--color-accent); } } }"));
    expect(out).toBe(`.hover\\:bg-accent { &${is(":hover", "hover")} { @media (hover: hover) { background-color: var(--color-accent); } @media (hover: none) { background-color: var(--color-accent); } } }`);
  });

  test("a top-level `@media (hover: hover)` keeps its rules and gets a twin-only copy for touch screens", () => {
    const out = flat(twins("@layer utilities { @media (hover: hover) { .hover\\:x:hover { color: red; } .y { color: blue; } } }"));
    expect(out).toContain(`@media (hover: hover) { .hover\\:x${is(":hover", "hover")} { color: red; } .y { color: blue; } }`);
    // Only the hover rules, only the forced class: a phone's real tap does not stick.
    expect(out).toContain("@media (hover: none) { .hover\\:x:is(.youi-state-hover, .youi-state-hover *) { color: red; }}");
    expect(out.match(/\.y \{/g)).toHaveLength(1);
  });

  test("a pseudo-element after the state stays after the twin", () => {
    expect(twins('.x:hover::before { content: "a:hover;{"; }')).toBe(`.x${is(":hover", "hover")}::before { content: "a:hover;{"; }`);
    expect(twins("button::-moz-focus-inner { border: 0; } :-moz-focusring { outline: auto; }")).toBe("button::-moz-focus-inner { border: 0; } :-moz-focusring { outline: auto; }");
  });

  test("group and peer selectors: the state inside :is(:where(.group):hover *) is twinned", () => {
    expect(twins(".group-hover\\:underline:is(:where(.group):hover *) { text-decoration: underline; }")).toBe(`.group-hover\\:underline:is(:where(.group)${is(":hover", "hover")} *) { text-decoration: underline; }`);
  });

  test(":not(:disabled) is left alone, so it still reads the element itself", () => {
    expect(twins(".b:not(:disabled):hover { opacity: .9; }")).toBe(`.b:not(:disabled)${is(":hover", "hover")} { opacity: .9; }`);
    expect(twins(".b:not([aria-disabled=true]) { cursor: pointer; }")).toBe(".b:not([aria-disabled=true]) { cursor: pointer; }");
  });

  test(":focus-visible is one state, never `:focus` followed by `-visible`", () => {
    const out = twins(".r:focus-visible { outline: 2px solid; }");
    expect(out).not.toContain(":focus,");
    expect(out).toBe(`.r${is(":focus-visible", "focus")} { outline: 2px solid; }`);
  });

  test("a selector list twins each selector; other at-rules, strings, comments and data URIs are untouched", () => {
    const css = [
      '@import url("https://fonts.example/x.css");',
      "/* a :hover in a comment */",
      ".a:hover, .b:focus { color: red; }",
      '[data-x="a:hover"] { color: blue; }',
      "@keyframes spin { from { transform: rotate(0); } }",
      "@supports selector(:focus-visible) { .c { color: green; } }",
      "@font-face { src: url(data:font/woff2;base64,AA;BB); }",
    ].join("\n");
    const out = twins(css);
    expect(out).toContain(`.a${is(":hover", "hover")}, .b${is(":focus", "focus")} { color: red; }`);
    for (const line of ['@import url("https://fonts.example/x.css");', "/* a :hover in a comment */", '[data-x="a:hover"] { color: blue; }', "@keyframes spin { from { transform: rotate(0); } }", "@supports selector(:focus-visible) { .c { color: green; } }", "@font-face { src: url(data:font/woff2;base64,AA;BB); }"]) expect(out).toContain(line);
  });

  test("idempotent: a rewritten sheet is never twinned twice", () => {
    const once = forcedStates(".a:hover { color: red; } @media (hover: hover) { .b:hover { color: blue; } }");
    expect(forcedStates(once)).toBe(once);
    expect(once.match(/youi-state-hover \*/g)).toHaveLength(3);
    expect(once.split(STATES_MARKER)).toHaveLength(2);
  });
});

describe("a built sheet carries each twin exactly once (c1)", () => {
  test("a project's plain stylesheet, light and dark, built twice (the second a cache hit)", async () => {
    const root = mkdtempSync(join(tmpdir(), "youi-states-"));
    const cache = new SpecimenCache(mkdtempSync(join(tmpdir(), "youi-states-cache-")));
    try {
      writeFileSync(join(root, "package.json"), '{ "name": "states", "private": true }\n');
      writeFileSync(join(root, "index.html"), '<!doctype html><link rel="stylesheet" href="/ui.css"><button class="b">Go</button>\n');
      writeFileSync(join(root, "ui.css"), ['.b { color: black; }', ".b:hover { color: red; }", ".b:focus-visible { outline: 2px solid; }", ".b:focus { outline-offset: 2px; }", ".b:active { color: maroon; }", ".b:disabled, .b[disabled], .b[aria-disabled=\"true\"] { opacity: .5; }"].join("\n"));
      const project = { id: "states", root, commit: "c0ffee", looks: [] };
      const stats = newStats();
      const first = await projectSpecimens(project, { cache, stats });
      const again = await projectSpecimens(project, { cache, stats });
      expect(stats).toMatchObject({ misses: 1, hits: 1 });
      expect(again.css).toEqual(first.css);
      for (const scheme of ["light", "dark"] as const) {
        const css = first.css![scheme];
        for (const [twin, state] of [[":hover", "hover"], [":focus-visible", "focus"], [":focus", "focus"], [":active", "active"], [":disabled", "disabled"], ["[disabled]", "disabled"], ['[aria-disabled="true"]', "disabled"]] as const) {
          expect(css.split(`.b${is(twin, state)}`)).toHaveLength(2);
        }
        expect(css.split(STATES_MARKER)).toHaveLength(2);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cache.dir, { recursive: true, force: true });
    }
  });
});
