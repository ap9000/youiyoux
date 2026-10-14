import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { renderShots } from "@youiyoux/scanner";
import { addLooks } from "../src/report/looks.ts";
import { buildReportModel } from "../src/report/model.ts";
import { renderHtml } from "../src/report/html.ts";
import { Redactor } from "../src/report/safe.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import { fixtureRepo, singleFiles } from "./report-fixtures.ts";

vi.mock("@youiyoux/scanner", async (original) => ({ ...await original<object>(), renderShots: vi.fn() }));
afterEach(() => vi.clearAllMocks());

test("without repo dependencies no look is embedded and the installation next step is shown (c9)", async () => {
  const repo = fixtureRepo("unstyled", singleFiles());
  try {
    const model = await buildReportModel(repo.dir);
    await addLooks(model, repo.dir);
    expect(renderShots).not.toHaveBeenCalled();
    expect(model.projects[0]!.rendered).toEqual([]);
    expect(model.render.note).toContain("Install the repo's dependencies to see rendered looks");
    expect(renderHtml(model)).toContain("Install the repo&#39;s dependencies to see rendered looks");
  } finally { repo.remove(); }
});

for (const note of ["the project loads no stylesheet youiyoux could find: looks are drawn unstyled", "react and react-dom are not installed", "Button did not render: drawn from its tag and classes"]) test(`suppresses unstyled project renders: ${note} (c9)`, async () => {
  const repo = fixtureRepo("unstyled-notes", singleFiles(), { link: true });
  try {
    vi.mocked(renderShots).mockResolvedValue({ notes: [note], components: [] } as unknown as Awaited<ReturnType<typeof renderShots>>);
    const model = await buildReportModel(repo.dir);
    await addLooks(model, repo.dir);
    expect(model.projects[0]!.rendered).toEqual([]);
    expect(model.render.note).toContain("Install the repo's dependencies to see rendered looks");
    expect(renderHtml(model)).toContain("Install the repo&#39;s dependencies to see rendered looks");
  } finally { repo.remove(); }
});

test("without a loaded stylesheet cached looks are not embedded either (c9)", async () => {
  const repo = fixtureRepo("no-styles", {
    "package.json": '{"name":"unstyled"}',
    "src/button.tsx": 'export function Button() { return <button className="h-9 px-4">Hello</button>; }',
    "src/page.tsx": 'import { Button } from "./button"; export function Page() { return <Button />; }',
  }, { link: true });
  try {
    const model = await buildReportModel(repo.dir);
    await addLooks(model, repo.dir);
    expect(renderShots).not.toHaveBeenCalled();
    expect(model.render.note).toContain("Install the repo's dependencies to see rendered looks");
    expect(model.projects[0]!.rendered).toEqual([]);
  } finally { repo.remove(); }
});

test("render captions and the safety backstop keep classes but remove literal props and text, unless include-code (c10)", async () => {
  const repo = fixtureRepo("caption", singleFiles(), { link: true });
  const cache = mkdtempSync(join(tmpdir(), "youiyoux-caption-"));
  const png = join(cache, "shot.png");
  writeFileSync(png, Buffer.from("fixture image"));
  const caption = 'Button href="https://fixture.invalid/register" variant="private-variant" className="h-9 px-4" "Private customer label"';
  try {
    vi.mocked(renderShots).mockResolvedValue({ notes: [], components: [{ component: "Button", looks: [caption], notes: [], shots: [{ scheme: "light", width: 390, path: png }] }, { component: "Dialog", looks: ["Dialog"], notes: ["Dialog did not render: drawn from its tag and classes"], shots: [{ scheme: "light", width: 390, path: png }] }] } as unknown as Awaited<ReturnType<typeof renderShots>>);
    for (const includeCode of [false, true]) {
      const model = await buildReportModel(repo.dir, { includeCode });
      await addLooks(model, repo.dir);
      expect(model.projects[0]!.rendered).toHaveLength(1);
      const looks = model.projects[0]!.rendered[0]!.looks.join(" ");
      expect(looks).toContain('class');
      expect(looks.includes("https://fixture.invalid/register")).toBe(includeCode);
      expect(looks.includes("Private customer label")).toBe(includeCode);
      expect(looks.includes("private-variant")).toBe(includeCode);
      const safe = new Redactor({ root: repo.dir, includeCode, env: {} }).model({ looks: [caption] });
      expect(safe.looks[0]!.includes("Private customer label")).toBe(includeCode);
      expect(safe.looks[0]).toContain(includeCode ? 'className="h-9 px-4"' : 'class="h-9 px-4"');
    }
  } finally { repo.remove(); rmSync(cache, { recursive: true, force: true }); }
});

test("the dependencies hint appears once per report, with where it applies and what to do next (c5)", async () => {
  const app = (name: string) => ({
    [`apps/${name}/package.json`]: JSON.stringify({ name, private: true, dependencies: { react: "19.3.0", "react-dom": "19.3.0" } }),
    [`apps/${name}/src/button.tsx`]: 'export function Button(props) { return <button className="h-9 px-4 rounded-md" {...props} />; }\n',
    [`apps/${name}/src/page.tsx`]: 'import { Button } from "./button";\nexport function Page() { return <><Button /><Button /></>; }\n',
  });
  const repo = fixtureRepo("deps-once", { "package.json": '{"name":"two-apps","private":true}', "pnpm-workspace.yaml": "packages:\n  - apps/*\n", ...app("web"), ...app("admin") });
  try {
    const model = await buildReportModel(repo.dir);
    expect(model.projects.filter((p) => p.components.length > 0).length).toBeGreaterThan(1);
    await addLooks(model, repo.dir);
    const html = renderHtml(model);
    const markdown = renderMarkdown(model, "youiyoux-report.html");
    for (const text of [model.render.note, html, markdown]) expect(text.match(/Install the repo(?:'|&#39;)s dependencies/g)).toHaveLength(1);
    expect(model.render.note).toContain("apps/admin, apps/web");
    expect(html).toContain("then run npx youiyoux again");
    expect(markdown).toContain("Next: install the repo's dependencies");
  } finally { repo.remove(); }
});
