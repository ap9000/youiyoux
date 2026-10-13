import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildModel } from "../src/data/model.ts";
import type { Catalog, Manifest } from "../src/data/types.ts";
import { collectPinned, pinnedRule, resolveNesting } from "../src/preview/pin.ts";
import { bezierPoints } from "../src/screens/style/fields.tsx";
import { applyEdit, contrastWarnings, cssOf, editorModel, EMPTY, groupOf, previewVars, sourceOf, type EditAction } from "../src/screens/style/model.ts";
import { tokenFocus } from "../src/screens/style/uses.ts";

const DATA = join(import.meta.dirname, "../snapshot/public/data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
const catalog = JSON.parse(readFileSync(join(DATA, manifest.systems[0]!.catalog), "utf8")) as Catalog;
const hub = buildModel(catalog, manifest);
const model = editorModel("demo", "demo", [...hub.tokens.values()], catalog.components.map((c) => c.contract));
const color = (hex: string) => ({ colorSpace: "srgb", components: [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 10000) / 10000), hex });
const run = (...actions: EditAction[]) => actions.reduce((content, action) => applyEdit(model, content, action), EMPTY);

describe("the editor model", () => {
  test("groups every demo token where the editor shows it", () => {
    const group = (path: string) => groupOf(hub.tokenByPath.get(path)!);
    expect([group("color.brand"), group("typography.label"), group("space.md"), group("radius.card"), group("border.control"), group("shadow.card"), group("motion.spring.snappy"), group("motion.duration.fast"), group("easing.out"), group("focus.ring"), group("opacity.disabled")]).toEqual(["color", "type", "space", "radius", "border", "shadow", "motion", "motion", "motion", "focus", "other"]);
  });

  test("the snapshot carries values as written, aliases kept, and which tokens have their own dark value", () => {
    expect(hub.tokenByPath.get("color.accent")).toMatchObject({ source: { light: "{color.brand}" }, darkOwn: false });
    expect(hub.tokenByPath.get("color.brand")!.darkOwn).toBe(true);
    expect(hub.tokenByPath.get("focus.ring")!.source!.light).toMatchObject({ color: "{color.accent}" });
  });

  test("an edit follows aliases; dark follows light until the token has its own", () => {
    const content = run({ type: "token", path: "color.brand", scheme: "light", value: color("#c2410c") });
    expect(cssOf(model, content, "color.accent", "light")).toBe("#c2410c");
    expect(cssOf(model, content, "color.accent", "dark")).toBe("#8c85ff");
    expect(cssOf(model, content, "focus.ring", "light")).toBe("2px solid #c2410c");
    const radius = run({ type: "token", path: "radius.card", scheme: "light", value: { value: 16, unit: "px" } });
    expect(sourceOf(model, radius, "radius.card", "dark")).toEqual({ value: 16, unit: "px" });
  });

  test("the reducer drops edits that return to the published value, and separates dark", () => {
    const published = hub.tokenByPath.get("radius.card")!.source!.light;
    expect(run({ type: "token", path: "radius.card", scheme: "light", value: { value: 16, unit: "px" } }, { type: "token", path: "radius.card", scheme: "light", value: published })).toEqual(EMPTY);
    const dark = run({ type: "dark-own", path: "color.accent" }, { type: "token", path: "color.accent", scheme: "dark", value: "{color.danger}" });
    expect(dark.tokens).toEqual([{ path: "color.accent", dark: "{color.danger}" }]);
    expect(run({ type: "dark-follows", path: "color.brand" }).tokens).toEqual([{ path: "color.brand", dark: null }]);
    const state = run({ type: "state", component: "youi:demo/component/button", state: "hover", role: "bg.default", token: "youi:demo/token/color.danger" });
    expect(state.states).toEqual([{ component: "youi:demo/component/button", state: "hover", role: "bg.default", token: "youi:demo/token/color.danger" }]);
    expect(applyEdit(model, state, { type: "state", component: "youi:demo/component/button", state: "hover", role: "bg.default", token: "youi:demo/token/color.accent-hover" }).states).toEqual([]);
  });
});

describe("what an edited token touches, for the phone preview", () => {
  const uses = (path: string, content = EMPTY) => tokenFocus(model, content, path)!.uses.map((u) => [u.kind, u.label, u.cssVar, u.on ?? u.fg ?? ""]);

  test("a colour nothing binds is sampled by its name: muted as text on every surface", () => {
    expect(tokenFocus(model, EMPTY, "color.muted")!.byName).toBe(true);
    expect(uses("color.muted")).toEqual([
      ["text", "on color.background", "--demo-color-muted", "--demo-color-background"],
      ["text", "on color.card", "--demo-color-muted", "--demo-color-card"],
    ]);
  });

  test("a colour's direct uses: component roles as text on their surface, surfaces with their text, borders, and composites that read it", () => {
    expect(uses("color.on-accent")).toEqual([["text", "Button fg.default", "--demo-color-on-accent", "--demo-color-accent"]]);
    expect(uses("color.card")).toContainEqual(["surface", "Card bg", "--demo-color-card", ""]);
    expect(uses("color.line")).toEqual(expect.arrayContaining([["border", "Card border", "--demo-color-line", ""], ["border", "Input border", "--demo-color-line", ""], ["border", "border.control", "--demo-border-control", ""]]));
    // A plain alias stands for the token: brand shows wherever accent does.
    expect(uses("color.brand")).toEqual(expect.arrayContaining([["surface", "Button bg.default (via color.accent)", "--demo-color-accent", "--demo-color-on-accent"], ["ring", "focus.ring (via color.accent)", "--demo-focus-ring", ""]]));
  });

  test("dimensions: radii by the components that bind them, spacing by name; types it cannot draw have no view", () => {
    expect(uses("radius.control")).toEqual([["radius", "Button radius", "--demo-radius-control", ""], ["radius", "Input radius", "--demo-radius-control", ""]]);
    expect(uses("space.md")).toEqual([["space", "gap and padding", "--demo-space-md", ""]]);
    expect(tokenFocus(model, EMPTY, "motion.duration.fast")).toBeNull();
  });

  test("uses follow the edits: a token that now aliases it counts", () => {
    const content = run({ type: "token", path: "color.card", scheme: "light", value: "{color.muted}" });
    expect(tokenFocus(model, content, "color.muted")!.uses.map((u) => u.label)).toContain("Card bg (via color.card)");
  });
});

describe("live preview overrides (style-css)", () => {
  test("override only edited tokens, as the token build writes them; aliases stay var()", () => {
    const vars = previewVars(model, run(
      { type: "token", path: "color.brand", scheme: "light", value: color("#c2410c") },
      { type: "token", path: "focus.ring", scheme: "light", value: { color: "{color.accent}", width: { value: 3, unit: "px" }, offset: { value: 2, unit: "px" }, style: "dashed" } },
      { type: "token", path: "motion.spring.snappy", scheme: "light", value: { stiffness: 300, damping: 14, mass: 1 } },
      { type: "state", component: "youi:demo/component/button", state: "hover", role: "bg.default", token: "youi:demo/token/color.danger" },
    ));
    expect(vars.light["--demo-color-brand"]).toBe("#c2410c");
    expect(vars.dark["--demo-color-brand"]).toBeUndefined();
    expect(vars.light["--demo-color-accent"]).toBeUndefined();
    expect(vars.light["--demo-focus-ring"]).toBe("3px dashed var(--demo-color-accent)");
    expect(vars.dark["--demo-focus-ring-style"]).toBe("dashed");
    expect(vars.light["--demo-motion-spring-snappy"]).toMatch(/^linear\(0, /);
    expect(vars.light["--demo-motion-spring-snappy-duration"]).toMatch(/^\d+ms$/);
    expect(vars.light["--demo-button-hover-bg-default"]).toBe("var(--demo-color-danger)");
    expect(vars.dark["--demo-button-hover-bg-default"]).toBe("var(--demo-color-danger)");
  });

  test("typography overrides its part variables, matching the frame's sheet", () => {
    const label = hub.tokenByPath.get("typography.label")!.source!.light as Record<string, unknown>;
    const vars = previewVars(model, run({ type: "token", path: "typography.label", scheme: "light", value: { ...label, fontSize: { value: 15, unit: "px" } } }));
    expect(vars.light).toMatchObject({ "--demo-typography-label-font-size": "15px", "--demo-typography-label": "500 15px/1.25 var(--demo-font-sans)", "--demo-typography-label-font-family": "var(--demo-font-sans)" });
    const sheet = readFileSync(join(import.meta.dirname, "../snapshot/preview/system.css"), "utf8");
    expect(sheet).toContain("--demo-typography-label-font-size: 13px;");
  });
});

describe("contrast in the editor", () => {
  test("a light grey muted is flagged below AA as new, with its ratio; passing pairs are not listed", () => {
    expect(contrastWarnings(model, EMPTY)).toEqual([]);
    const warnings = contrastWarnings(model, run({ type: "token", path: "color.muted", scheme: "light", value: color("#c4c4cc") }));
    expect(warnings.map((w) => `${w.pair.label} ${w.scheme} ${w.grade} new=${w.isNew}`).sort()).toEqual(["color.muted on color.background light Fail new=true", "color.muted on color.card light Fail new=true"]);
    expect(warnings).toHaveLength(2);
    for (const w of warnings) expect(w.ratio!).toBeLessThan(4.5);
  });

  test("a focus ring moved onto the element (offset 0) is checked against the fills it is drawn over", () => {
    // The demo ring is accent at a 2px offset: it sits on the surface, so Button's accent fill is not its background.
    expect(contrastWarnings(model, EMPTY)).toEqual([]);
    const inside = run({ type: "token", path: "focus.ring", scheme: "light", value: { color: "{color.accent}", width: { value: 2, unit: "px" }, offset: { value: 0, unit: "px" }, style: "solid" } });
    const warnings = contrastWarnings(model, inside);
    expect(warnings.map((w) => `${w.pair.label} ${w.scheme} new=${w.isNew}`)).toEqual(expect.arrayContaining(["focus.ring (focus.ring.color) on Button bg.default (hover) light new=true"]));
    expect(warnings.every((w) => w.pair.kind === "ui" && w.required === 3)).toBe(true);
  });

  test("a colour the editor cannot read is a failure with its reason, not a pass", () => {
    const unread = run({ type: "token", path: "color.muted", scheme: "light", value: { colorSpace: "srgb", components: [Number.NaN, 0, 0] } });
    const warnings = contrastWarnings(model, unread).filter((w) => w.pair.foreground === "color.muted" && w.scheme === "light");
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(w).toMatchObject({ passes: false, ratio: null, grade: null, isNew: true, unreadable: expect.stringContaining("could not read colour color.muted (light: ") });
  });

  test("a hover re-bound to a low-contrast fill is flagged for the contract and state", () => {
    const warnings = contrastWarnings(model, run({ type: "state", component: "youi:demo/component/button", state: "hover", role: "bg.default", token: "youi:demo/token/color.card" }));
    expect(warnings.map((w) => w.pair.label)).toContain("Button default (hover): text on fill");
  });
});

describe("pinned states in the preview frame", () => {
  test("nested Tailwind rules resolve and pin without their pseudo-class", () => {
    expect(resolveNesting("&:hover", ".hover\\:bg-x")).toBe(".hover\\:bg-x:hover");
    expect(resolveNesting(".child", ".a, .b")).toBe(":is(.a, .b) .child");
    expect(pinnedRule(".btn:hover", "background: red;", "hover")).toBe('[data-pin-state="hover"] :is(.btn) { background: red; }');
    expect(pinnedRule(".btn:focus-visible", "outline: 2px solid;", "focus")).toBe('[data-pin-state="focus"] :is(.btn) { outline: 2px solid; }');
    expect(pinnedRule(".btn", "color: red;", "hover")).toBeNull();
    const rules = [{ cssRules: [{ selectorText: ".hover\\:bg-x", style: { cssText: "" }, cssRules: [{ selectorText: "&:hover", style: { cssText: "" }, cssRules: [{ cssRules: [{ selectorText: "&", style: { cssText: "background-color: var(--x);" } }] }] }] }] }];
    expect(collectPinned(rules as never, "hover")).toEqual(['[data-pin-state="hover"] :is(.hover\\:bg-x) { background-color: var(--x); }']);
  });

  test("bezier curves end at 0 and 1", () => {
    const points = bezierPoints([0.2, 0.8, 0.2, 1]);
    expect(points[0]).toBeCloseTo(0, 5);
    expect(points.at(-1)).toBeCloseTo(1, 5);
  });
});
