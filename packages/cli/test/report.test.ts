/**
 * `youiyoux report` on the shadcn-style fixture (c2): every section is there (projects, UI libraries,
 * inventory, near-duplicate groups, hardcoded values, off-library imports, top fixes), each finding
 * and each section ends with a Next step, and the HTML can make no request: no external URL in any
 * src, href, url() or @import, and a policy of default-src 'none'. Also the Markdown summary, the
 * card's size, project discovery and the five printed lines.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encodePng, textWidth } from "../src/report/card.ts";
import { findProjects } from "../src/report/projects.ts";
import { fixtureRepo, monorepoFiles, report, singleFiles, type FixtureRepo } from "./report-fixtures.ts";

let repo: FixtureRepo;
let run: Awaited<ReturnType<typeof report>>;
let html = "";

beforeAll(async () => {
  repo = fixtureRepo("single", singleFiles());
  run = await report(repo.dir);
  html = readFileSync(join(repo.dir, "youiyoux-report.html"), "utf8");
}, 60_000);
afterAll(() => repo.remove());

/** The HTML of one `data-section`, up to its closing tag (sections nest one level in a project). */
function section(name: string, from = html): string {
  const start = from.indexOf(`data-section="${name}"`);
  expect(start, `section ${name}`).toBeGreaterThan(-1);
  const open = from.lastIndexOf("<", start);
  const tag = from.slice(open + 1, from.indexOf(" ", open));
  let depth = 0;
  const pattern = new RegExp(`<(/?)${tag}\\b`, "g");
  pattern.lastIndex = open;
  for (let m = pattern.exec(from); m; m = pattern.exec(from)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return from.slice(open, m.index);
  }
  return from.slice(open);
}

const findingsOf = (part: string): string[] => part.split('<li class="finding"').slice(1);

describe("youiyoux report: the shadcn-style fixture", () => {
  test("prints five plain-English lines, the three paths and what to do next", () => {
    expect(run.code).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "acme-shop: 1 project, 9 files scanned; UI libraries: shadcn/ui, Headless UI, Radix Primitives.",
      "Components: 6 defined, 11 buttons, inputs, cards and other UI elements in use; most used: Button (5 uses).",
      "Near-duplicates: 1 group of components that look the same but are built more than once.",
      "Hardcoded values: 3 colours, spacings and radii a theme token already holds; off-library imports: 1.",
      expect.stringMatching(/^Top fix: Colour #dc2626 is hardcoded in 2 places; .*use var\(--color-danger\)/),
    ]);
    expect(lines.slice(5, 9).map((l) => l.split(/\s+/).at(-1)!.split("/").at(-1))).toEqual(["", "youiyoux-report.html", "youiyoux-card.png", "youiyoux-summary.md"]);
    expect(lines.at(-1)).toMatch(/^Next: open .*youiyoux-report\.html .*npx youiyoux agents install/);
  });

  test("shows projects, UI libraries, inventory, near-duplicate groups, hardcoded values, off-library imports and top fixes (c2)", () => {
    expect(section("projects")).toContain("One project");
    const project = section("project");
    expect(project).toContain('data-project="."');
    const libraries = section("libraries", project);
    for (const name of ["shadcn/ui", "Headless UI", "Radix Primitives"]) expect(libraries).toContain(name);
    const inventory = section("inventory", project);
    expect(inventory).toContain("6 components defined");
    expect(inventory).toMatch(/Button <small>src\/components\/ui\/button\.tsx<\/small><\/span><span>5 uses/);
    const near = section("near-duplicates", project);
    expect(findingsOf(near)).toHaveLength(1);
    expect(near).toContain("6 buttons look the same (36px high, 16px side padding, 6px corners, 14px text) but are built 2 ways");
    expect(near).toContain("<strong>Next:</strong> Keep Button (src/components/ui/button.tsx).</p><ol class=\"steps\"><li>In src/components/fancy-button.tsx, build FancyButton on Button instead of restyling its own element (import { Button } from &quot;@/components/ui/button&quot;)</li></ol>");
    const hardcoded = section("hardcoded", project);
    expect(findingsOf(hardcoded)).toHaveLength(2);
    expect(hardcoded).toContain("Colour #dc2626 is hardcoded in 2 places");
    expect(hardcoded).toContain("<code>src/app/page.tsx:13</code>");
    expect(hardcoded).toContain("Use var(--color-danger)");
    const off = section("off-library", project);
    expect(off).toContain("Imports a dialog from Headless UI (@headlessui/react); this project&#39;s dialogs come from shadcn/ui");
    expect(off).toContain("<code>src/components/promo-modal.tsx:1</code>");
    expect(findingsOf(section("top-fixes"))).toHaveLength(4);
    expect(html).toContain("Set up youiyoux for your agent: run npx youiyoux agents install");
  });

  test("every finding and every section says what to do next", () => {
    const all = findingsOf(html);
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const finding of all) expect(finding).toMatch(/<p class="next"><strong>Next:<\/strong> \S/);
    for (const name of ["top-fixes", "agent", "looks", "projects", "libraries", "inventory", "near-duplicates", "hardcoded", "off-library"]) expect(section(name), name).toContain("<strong>Next:</strong>");
  });

  test("makes no external request: no remote URL anywhere it could load from, and a policy that blocks everything else", () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`);
    for (const [, url] of html.matchAll(/\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)) expect(url).toMatch(/^(?:#|data:image\/png;base64,)/);
    for (const [, url] of html.matchAll(/url\(\s*["']?([^"')]+)/gi)) expect(url).toMatch(/^data:/);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(html).not.toMatch(/<script|<link|<iframe|<object|<embed/i);
  });

  test("the Markdown summary: the five lines, the numbers, the top fixes with their next steps, and the agent line", () => {
    const md = readFileSync(join(repo.dir, "youiyoux-summary.md"), "utf8");
    expect(md).toMatch(/^## youiyoux report: acme-shop\n\n- acme-shop: 1 project/);
    expect(md).toContain("| 1 | 6 | 1 | 3 | 1 |");
    expect(md.match(/^\d\. /gm)).toHaveLength(4);
    expect(md.match(/^ {3}Next: /gm)).toHaveLength(4);
    expect(md).toContain("Set up youiyoux for your agent: run npx youiyoux agents install");
    expect(md).toContain("Run npx youiyoux --render");
  });

  test("the card is a 1200x630 PNG with only IHDR, IDAT and IEND chunks", () => {
    const png = readFileSync(join(repo.dir, "youiyoux-card.png"));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    const chunks: string[] = [];
    for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) chunks.push(png.toString("ascii", at + 4, at + 8));
    expect(chunks).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  test("--out writes the three files there, and --json gives the model with their paths", async () => {
    const out = join(repo.dir, "..", `${repo.dir.split("/").at(-1)}-out`);
    const json = await report(repo.dir, { out, json: true });
    const model = JSON.parse(json.stdout) as { files: { report: string; card: string; summary: string }; totals: Record<string, unknown>; summary: string[] };
    expect(model.files.report).toBe(join(out, "youiyoux-report.html"));
    expect(model.totals).toMatchObject({ projects: 1, nearDuplicates: 1, hardcoded: 3, offLibrary: 1 });
    expect(model.summary).toHaveLength(5);
    expect(readFileSync(model.files.card).subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("report pieces", () => {
  test("project discovery: workspace members with UI files, named from package.json, never from a remote", async () => {
    const mono = fixtureRepo("discover", monorepoFiles(), { git: false });
    try {
      const found = await findProjects(mono.dir);
      expect(found.name).toBe("acme-monorepo");
      expect(found.projects.map((p) => [p.dir, p.name])).toEqual([["apps/admin", "@acme/admin"], ["apps/web", "@acme/web"], ["packages/ui", "@acme/ui"]]);
      expect(found.skipped).toEqual(["tools/scripts"]);
    } finally {
      mono.remove();
    }
  });

  test("the card's text: measured in whole glyphs, anything outside ASCII drawn as a safe stand-in", () => {
    expect(textWidth("ab", 2)).toBe(2 * 6 * 2 - 2);
    expect(textWidth("日本", 1)).toBe(textWidth("??", 1));
    expect(encodePng(1, 1, new Uint8Array([1, 2, 3])).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
