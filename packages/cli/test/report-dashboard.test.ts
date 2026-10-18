/**
 * The report follows youiyoux's own design rules (apps/web/design/rules): a section rail with
 * counts, a headline sentence with a split bar, a shape map, near-duplicates as a Canonical | Replace comparison with
 * their measurements as chips, a colour swatch on hardcoded colours, and that swatch never lets
 * a title carry anything else into a style attribute.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildReportModel, type Finding, type ReportModel } from "../src/report/model.ts";
import { renderHtml } from "../src/report/html.ts";
import { fixtureRepo, singleFiles, type FixtureRepo } from "./report-fixtures.ts";

let repo: FixtureRepo;
let model: ReportModel;
let html = "";

beforeAll(async () => {
  repo = fixtureRepo("dashboard", singleFiles());
  model = await buildReportModel(repo.dir);
  html = renderHtml(model);
}, 60_000);
afterAll(() => repo.remove());

test("a rail links to every section with its count (layout.section-rail)", () => {
  const rail = html.slice(html.indexOf('<aside class="rail">'), html.indexOf("</aside>"));
  const t = model.totals;
  expect(rail).toContain(`<a href="#top-fixes"><span>Top fixes</span><span class="n warn">${model.topFixes.length}</span></a>`);
  expect(rail).toContain(`<a href="#p-root-near"><span>Near-duplicates</span><span class="n${t.nearDuplicates > 0 ? " warn" : ""}">${t.nearDuplicates}</span></a>`);
  expect(rail).toContain(`<a href="#p-root-hardcoded"><span>Hardcoded values</span><span class="n warn">${t.hardcoded}</span></a>`);
  for (const [, id] of rail.matchAll(/href="#([^"]+)"/g)) expect(html, id).toContain(`id="${id}"`);
});

test("the headline is a sentence with its numbers, a split bar and a counted legend; zero says Clean (data.headline)", () => {
  const t = model.totals;
  const head = html.slice(html.indexOf('data-section="headline"'), html.indexOf("</section>", html.indexOf('data-section="headline"')));
  expect(head).toContain(`<b class="warn">${t.nearDuplicates}</b> ${t.nearDuplicates === 1 ? "look is" : "looks are"} built more than once`);
  expect(head).toContain(`<b class="warn">${t.hardcoded}</b> values skip the theme`);
  expect(head).toMatch(/<div class="split" role="img" aria-label="Near-duplicates \d+, Hardcoded values \d+, Off-library imports \d+">/);
  expect(html).not.toContain('class="tiles"');
  const clean = renderHtml({ ...model, totals: { ...model.totals, nearDuplicates: 0, hardcoded: 0, offLibrary: 0 }, projects: model.projects.map((p) => ({ ...p, nearDuplicates: [], hardcoded: [], offLibrary: [] })) });
  expect(clean).toContain('<p class="say">Every look is built once and every value comes from the theme.</p>');
  expect(clean).not.toContain('<div class="split"');
  expect(clean.match(/<span class="clean">Clean<\/span>/g)).toHaveLength(3);
});

test("the shape map draws one square per shape: the first solid, every extra outlined; unmeasured is not zero (data.headline)", () => {
  const map = html.slice(html.indexOf('data-section="shapes"'), html.indexOf("</section>", html.indexOf('data-section="shapes"')));
  for (const r of model.projects[0]!.roles) {
    const row = map.slice(map.indexOf(`<span class="role mono">${r.role}</span>`), map.indexOf("</li>", map.indexOf(`<span class="role mono">${r.role}</span>`)));
    if (r.families === 0) expect(row).toContain("shape not measured");
    else expect([(row.match(/<i class="one"><\/i>/g) ?? []).length, (row.match(/<i class="more"><\/i>/g) ?? []).length]).toEqual([1, r.families - 1]);
  }
  const wide = renderHtml({ ...model, projects: [{ ...model.projects[0]!, roles: [{ role: "button", uses: 300, families: 55 }, { role: "dialog", uses: 4, families: 0 }] }] });
  expect(wide.match(/<i class="(?:one|more)"><\/i>/g)).toHaveLength(40);
  expect(wide).toContain('<span class="over">+15</span>');
  expect(wide).toContain('<span class="unmeasured">shape not measured</span>');
});

test("files that could not be read are a small alert with hover detail beside the legend and one folded list, never a pass", () => {
  const partial = renderHtml({ ...model, projects: [{ ...model.projects[0]!, failed: ["src/a.tsx: 1 parse error node(s)", "src/b.tsx: 2 parse error node(s)"] }] });
  expect(partial).not.toContain('class="caveat"');
  expect(partial).toContain('<li class="alert"><a href="#p-root-unread" aria-describedby="unread-tip"><i aria-hidden="true">!</i>2 not read</a><span class="tip" id="unread-tip" role="tooltip">2 files could not be fully read: what is in them is unknown, not zero.</span></li>');
  expect(partial).toContain('<div class="unread-at" id="p-root-unread">');
  expect(partial).toContain('<details class="incomplete more"><summary>2 files not fully read; what is in them is unknown</summary>');
});

test("a near-duplicate is a Canonical | Replace comparison with its measurements as chips (findings.show-compare)", () => {
  const near = html.slice(html.indexOf('data-section="near-duplicates"'));
  expect(near).toMatch(/<li class="finding" data-kind="near-duplicate"><div class="head"><span class="count">\d+<small>places?<\/small><\/span>/);
  expect(near).toContain('<ul class="specs"><li>36px high</li>');
  expect(near).toMatch(/<div class="compare"><p class="next"><strong>Next:<\/strong> Keep Button/);
});

test("a hardcoded colour shows its swatch; a title can't smuggle CSS through it", () => {
  expect(html).toContain('<span class="swatch" style="background:#dc2626" aria-hidden="true"></span>Hardcoded');
  const hostile = (title: string): string => {
    const project = model.projects[0]!;
    const finding: Finding = { ...project.hardcoded[0]!, title };
    return renderHtml({ ...model, topFixes: [finding], projects: [{ ...project, hardcoded: [finding] }] });
  };
  for (const title of ["Colour rgb(0 0 0;background:url(x)) is hardcoded", "Colour #fff;background-image:url(x) is hardcoded", 'Colour #abc" onmouseover="x is hardcoded']) {
    const out = hostile(title);
    const styles = [...out.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
    for (const style of styles) expect(style, title).toMatch(/^(?:background:(?:#[0-9a-fA-F]{3,8}|[a-z]+\([0-9.,%\s/+-]+\))|width:\d+(?:\.\d+)?%)$/);
  }
});

test("the report and the share card wear the hub's palette: one accent over neutrals (color.status-only)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const design = (name: string): string => fileURLToPath(new URL(`../../../apps/web/design/${name}`, import.meta.url));
  const tokens = async (name: string): Promise<Record<string, string>> => {
    const json = JSON.parse(await readFile(design(name), "utf8")) as { color: Record<string, { $value: { hex?: string } }> };
    return Object.fromEntries(Object.entries(json.color).flatMap(([k, v]) => (v.$value?.hex ? [[k, v.$value.hex]] : [])));
  };
  const vars = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  const light = vars(html.match(/:root\{color-scheme:light dark;[^}]*\}/)![0]);
  const dark = vars(html.match(/@media \(prefers-color-scheme:dark\)\{:root\{[^}]*\}/)![0]);
  const [hubLight, hubDark] = [await tokens("youiyoux.tokens.json"), await tokens("youiyoux.dark.tokens.json")];
  expect(Object.keys(light).length).toBeGreaterThan(15);
  for (const [k, v] of Object.entries(light)) expect(v, `light ${k}`).toBe(hubLight[k]);
  for (const [k, v] of Object.entries(dark)) expect(v, `dark ${k}`).toBe(hubDark[k]);
  // No yellow anywhere and no traffic-light primaries in the report's own styles.
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  expect(css).not.toMatch(/#(?:f1a10d|a35200|fbbf24|eab308|f59e0b|ff0000|00ff00|0000ff|18794e|c4321f|4cc38a)\b/i);
  expect(css).not.toContain("--warning");
  const card = await readFile(new URL("../src/report/card.ts", import.meta.url), "utf8");
  const hex = (h: string): string => `[${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(", ")}]`;
  for (const [key, token] of [["background", "canvas"], ["accent", "accent"], ["text", "ink"], ["muted", "muted"], ["ok", "success"], ["track", "neutral-soft"]] as const) expect(card, key).toContain(`${key}: ${hex(hubDark[token]!)}`);
});
