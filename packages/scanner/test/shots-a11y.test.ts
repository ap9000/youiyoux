import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderComponents, withNamePlaceholders } from "../src/specimens/render.ts";
import { browserLookOf } from "../src/specimens/build.ts";
import { newStats } from "../src/specimens/cache.ts";
import { describe, expect, test } from "vitest";
import { buildInventory } from "../src/index.ts";
import { compareA11yIssues, groupOf, shotsText, type A11yIssue, type ShotsReport } from "../src/specimens/shots.ts";
import { eyesRepo } from "./eyes-repo.ts";

const issue = (overrides: Partial<A11yIssue> = {}): A11yIssue => ({
  rule: "button-name", impact: "critical", help: "Buttons need names", url: "https://example.invalid/rule",
  status: "not-compared", specimenOnly: null, look: "button", path: "button:nth-child(1)", markup: "<button></button>",
  count: 1, schemes: ["light", "dark"], widths: [1280, 390], targets: [{ selector: "button", html: "<button></button>", fix: "Give the button a name" }], ...overrides,
});
const report = (a11y: readonly A11yIssue[]): ShotsReport => ({
  project: "test", root: "/test", base: { ref: "main", commit: "123456789" }, baseNote: null, unchanged: [], notes: [], dir: "/cache",
  components: [{ component: "Button", file: "button.tsx", looks: ["Button"], shots: [{ scheme: "light", width: 1280, path: "/cache/light.png" }], a11y, diff: { none: "unchanged" }, cached: false, notes: [] }],
});

describe("accessibility comparison and agent advice", () => {
  test("a shared rule can have pre-existing, new and fixed elements, with only new ones actionable", () => {
    const before = [issue(), issue({ rule: "label", path: "input", markup: "<input>" })];
    const after = [issue(), issue({ path: "button:nth-child(2)" })];
    const compared = compareA11yIssues(after, before);
    expect(compared.map((i) => [i.rule, i.status])).toEqual([["button-name", "pre-existing"], ["button-name", "new"], ["label", "fixed"]]);
    const text = shotsText(report(compared));
    expect(text).toContain("pre-existing: already at main (1234567), not from this change");
    expect(text).toContain("fixed by this change");
    expect(text.split("\n").at(-1)).toBe("next: fix the 1 accessibility issue (button-name), then run youiyoux render button.tsx again");
  });

  test("class-only edits and moved elements match, but another look or more failing elements are new", () => {
    const original = issue();
    expect(compareA11yIssues([issue({ targets: [{ selector: ".new", html: '<button class="new"></button>', fix: "Name it" }] })], [original])[0]!.status).toBe("pre-existing");
    expect(compareA11yIssues([issue({ path: "button:nth-child(2)" })], [original])[0]!.status).toBe("pre-existing");
    expect(compareA11yIssues([issue({ look: "other" })], [original]).map((i) => i.status)).toEqual(["new", "fixed"]);
    expect(compareA11yIssues([issue({ count: 2 })], [original])[0]!.status).toBe("new");
    expect(compareA11yIssues([original], [issue({ schemes: ["light"] })])[0]!.status).toBe("new");
  });

  test("specimen-only, old, repaired and un-compared findings never ask the agent to fix code", () => {
    for (const entry of [issue({ status: "new", specimenOnly: ["aria-label"] }), issue({ status: "pre-existing" }), issue({ status: "fixed" }), issue()]) {
      const text = shotsText(report([entry]));
      expect(text.split("\n").at(-1)).not.toContain("fix the");
      if (entry.specimenOnly) expect(text).toContain("specimen-only: real usages pass aria-label");
    }
  });

  test("inventory keeps omitted name props and expression children, excludes handlers and omits empty metadata", async () => {
    const fixture = eyesRepo({ a11y: true });
    try {
      fixture.edit("src/app.tsx", "aria-label={label}", 'aria-label={label} id={label} title={label} onClick={() => {}} key={label}');
      const inventory = await buildInventory([fixture.dir], { cwd: fixture.dir });
      const recipes = inventory.looks.flatMap((l) => l.recipe?.kind === "component" ? [l.recipe] : []);
      expect(recipes.find((r) => r.export === "IconButton")?.dynamic).toEqual(["aria-label", "children", "id", "title"]);
      expect(recipes.find((r) => r.export === "Button")?.dynamic).toBeUndefined();
      const radio = recipes.filter((r) => r.export === "RadioCard");
      expect(radio).toHaveLength(2);
      for (const recipe of radio) {
        expect(recipe.dynamic).toEqual(["id", "title"]);
        expect(recipe.parent).toMatchObject({ file: "src/components/radio-group.tsx", export: "RadioGroup" });
        expect(recipe.wrappers).toEqual([]);
      }
    } finally { fixture.remove(); }
  });
});


test("required parent and representative names render the real label link; fallback only drops unsuppliable values", async () => {
  const fixture = eyesRepo({ a11y: true, git: false });
  const scratch = mkdtempSync(join(tmpdir(), "youi-names-"));
  try {
    fixture.write("src/components/render-button.tsx", 'export function RenderButton({ children, id }) { return <button id={id}>{children ? children() : null}</button>; }');
    const inventory = await buildInventory([fixture.dir], { cwd: fixture.dir });
    const group = groupOf(fixture.dir, inventory.looks, "RadioCard", null);
    expect(group.looks).toHaveLength(1);
    const jobs = group.looks.flatMap((l) => l.recipe.kind === "component" ? [withNamePlaceholders({ key: l.key, ...browserLookOf(l.recipe, l.role ?? "card") })] : []);
    const fallback = withNamePlaceholders({ key: "function", label: null, recipe: { kind: "component", file: "src/components/render-button.tsx", export: "RenderButton", props: {}, dynamic: ["children", "id"], label: null, wrappers: [], tag: "button", classes: [] } });
    const stats = newStats();
    const before = await renderComponents(fixture.dir, "tsconfig.json", [...jobs, fallback], scratch, stats);
    expect(before.failures.size).toBe(0);
    expect(stats.bundles).toBe(1);
    const html = before.html.get(jobs[0]!.key)!;
    const id = /<input[^>]* id="([^"]+)"/.exec(html)?.[1];
    expect(id).toMatch(/^youi-/);
    expect(html).toContain(`<label for="${id}">Example title</label>`);
    expect(before.suppliedNames.get(jobs[0]!.key)).toEqual(["id", "title"]);
    expect(before.suppliedNames.get("function")).toEqual([]);
    expect(before.html.get("function")).toBe("<button></button>");
    fixture.edit("src/components/radio-card.tsx", '<label htmlFor={id}>{title}</label>', "");
    const after = await renderComponents(fixture.dir, "tsconfig.json", jobs, scratch, newStats());
    expect(after.failures.size).toBe(0);
    expect(after.html.get(jobs[0]!.key)).toContain(`id="${id}"`);
    expect(after.html.get(jobs[0]!.key)).not.toContain("<label");
    expect(after.suppliedNames.get(jobs[0]!.key)).toEqual(["id", "title"]);
    // A genuinely standalone site prevents inferring a required parent for this component.
    fixture.edit("src/app.tsx", "<div><LinkedButton", '<div><RadioCard id="standalone" title="Standalone" /><LinkedButton');
    const mixed = await buildInventory([fixture.dir], { cwd: fixture.dir });
    const mixedGroup = groupOf(fixture.dir, mixed.looks, "RadioCard", null);
    expect(mixedGroup.looks.every((l) => l.recipe.kind === "component" && l.recipe.wrappers.length === 0)).toBe(true);
  } finally { fixture.remove(); rmSync(scratch, { recursive: true, force: true }); }
});
