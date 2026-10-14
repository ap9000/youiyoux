import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { buildReportModel } from "../src/report/model.ts";
import { fixtureRepo, singleFiles, type FixtureRepo } from "./report-fixtures.ts";

const repos: FixtureRepo[] = [];
const fixture = (extra: Record<string, string>) => {
  const repo = fixtureRepo("filters", singleFiles(extra));
  repos.push(repo);
  return repo;
};
afterEach(() => { for (const repo of repos.splice(0)) repo.remove(); });

test("route and convention exports, non-UI exports and unrelated same-named components are not duplicates (c7)", async () => {
  const extra: Record<string, string> = {};
  for (const dir of ["one", "two"]) {
    extra[`src/app/${dir}/route.ts`] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "generateMetadata", "generateStaticParams"].map((name) => `export function ${name}() { return { status: 200 }; }`).join("\n");
    extra[`src/lib/${dir}.ts`] = 'export function Form() { return "not UI"; }\nexport const Button = 42;';
    extra[`src/app/${dir}/page.tsx`] = 'export default function Page() { return <main><h1>Home</h1></main>; }';
    extra[`src/app/${dir}/layout.tsx`] = 'export default function Layout({children}) { return <section>{children}</section>; }';
  }
  extra["src/forms/one.tsx"] = 'export function Form() { return <form className="grid gap-4"><input /></form>; }';
  extra["src/forms/two.tsx"] = 'export function Form() { return <aside className="flex p-12"><textarea /></aside>; }';
  const repo = fixture(extra);
  const model = await buildReportModel(repo.dir);
  expect(model.totals.nearDuplicates).toBe(1); // positive control: FancyButton matches Button
  expect(JSON.stringify(model.projects[0]!.nearDuplicates)).not.toMatch(/src\/forms|src\/lib|src\/app\/one|src\/app\/two/);
  expect(model.projects[0]!.nearDuplicates[0]!.next).toContain("Keep Button");
});

test("var references and fallbacks, palette math, picker gradients and mismatched token groups produce no token finding (c7)", async () => {
  const repo = fixture({
    "src/lib/colors.ts": 'export const palette = { primary: "#2563eb", danger: "#dc2626" }; export const math = (n: number) => `rgb(${n} 0 0)`;',
    "src/components/color-picker.tsx": 'export function ColorPicker() { return <div style={{ background: "linear-gradient(to right, #2563eb, #dc2626)" }} />; }',
    "src/components/variables.tsx": 'export function Variables() { return <div className="text-[var(--color-primary,#2563eb)] gap-[var(--spacing-two)] gap-[8px] rounded-[7px] bg-[#123456]" />; }',
    "src/app/variables.css": ':root { --radius-only: 8px; --spacing-two: 2px; }\n.refs { color: var(--color-primary, #2563eb); padding: var(--spacing-two, 2px); gap: var(--spacing-two); }\n.wrong-group { gap: 8px; border-radius: 7px; }\n.control { padding: 2px; }',
  });
  const model = await buildReportModel(repo.dir);
  expect(model.totals.hardcoded).toBe(4); // original three plus exact spacing positive control
  const hardcoded = model.projects[0]!.hardcoded;
  expect(hardcoded.some((f) => f.next.includes("--spacing-two"))).toBe(true);
  expect(hardcoded.flatMap((f) => f.sites).filter((s) => /variables.css/.test(s.at)).map((s) => s.at)).toEqual(["src/app/variables.css:4"]);
  expect(JSON.stringify(hardcoded)).not.toMatch(/colors.ts|color-picker|variables.tsx|radius-only|rounded-\[7px\]/);
});

test("all showcase conventions contribute no usage, most-used headline, library verdict or off-library choice (c7)", async () => {
  const baseline = fixture({});
  const before = await buildReportModel(baseline.dir);
  const extra: Record<string, string> = {};
  for (const file of ["__stories__/show.tsx", "examples/show.tsx", "example/show.tsx", "demo/show.tsx", "demos/show.tsx", "playground/show.tsx", "storybook/show.tsx", ".storybook/show.tsx", "components/demo.stories.tsx", "components/demo.story.tsx"]) {
    extra[`src/${file}`] = 'import { Button } from "@/components/ui/button"; import { Modal } from "@mantine/core"; import { Dialog } from "@headlessui/react"; export function Showcase() { return <Modal><Dialog /><Button /><Button /><Button /><Button /><Button /><Button /></Modal>; }';
  }
  const repo = fixture(extra);
  const after = await buildReportModel(repo.dir);
  expect(after.projects[0]!.components).toEqual(before.projects[0]!.components);
  expect(after.projects[0]!.roles).toEqual(before.projects[0]!.roles);
  expect(after.summary[1]).toEqual(before.summary[1]);
  expect(after.projects[0]!.libraries).toEqual(before.projects[0]!.libraries);
  expect(after.projects[0]!.offLibrary).toEqual(before.projects[0]!.offLibrary);
  expect(after.totals.uses).toBe(before.totals.uses);
});

for (const alias of [true, false]) test(`one keeper, the design-system folder before a more-used local copy, valid imports from every copy (alias ${alias}) (c8)`, async () => {
  const repo = fixture({
    "src/ui/primitives.tsx": 'export function Button(props) { return <button className="inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium" {...props} />; }',
    "src/app/extra.tsx": 'import { Button } from "../ui/primitives"; export function Extra() { return <><Button /><Button /><Button /><Button /><Button /><Button /><Button /><Button /></>; }',
  });
  if (!alias) {
    repo.write("tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }));
    for (const file of ["src/app/page.tsx", "src/app/settings/page.tsx"]) {
      repo.write(file, readFileSync(join(repo.dir, file), "utf8").replaceAll("@/components/", file.includes("settings") ? "../../components/" : "../components/"));
    }
  }
  const model = await buildReportModel(repo.dir);
  const groups = model.projects[0]!.nearDuplicates;
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    expect(group.next.match(/Keep /g)).toHaveLength(1);
    expect(group.next).toMatch(/^Keep Button \(src\/components\/ui\/button.tsx\)/);
    const imports = [...(group.steps ?? []).join("\n").matchAll(/^In ([^,]+), .+? \(import \{ \S+ \} from "([^"]+)"\)$/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, from, specifier] of imports) {
      const config = ts.parseJsonConfigFileContent(JSON.parse(readFileSync(join(repo.dir, "tsconfig.json"), "utf8")), ts.sys, repo.dir).options;
      expect(ts.resolveModuleName(specifier!, join(repo.dir, from!), config, ts.sys).resolvedModule?.resolvedFileName).toBe(join(repo.dir, "src/components/ui/button.tsx"));
    }
  }
  expect(groups.some((g) => g.next.includes("In src/ui/primitives.tsx, remove its own Button"))).toBe(true);
  expect(groups.flatMap((g) => g.sites).every((s) => !s.at.startsWith("src/components/ui/button"))).toBe(true);
});

test("on equal usage the components/ui keeper wins (c8)", async () => {
  const repo = fixture({ "src/app/extra.tsx": 'import { FancyButton } from "../components/fancy-button"; export function Extra() { return <><FancyButton /><FancyButton /><FancyButton /><FancyButton /></>; }' });
  const model = await buildReportModel(repo.dir);
  expect(model.projects[0]!.nearDuplicates[0]!.next).toMatch(/^Keep Button \(src\/components\/ui\/button.tsx\)/);
});

test("same-named used buttons without a known shared shape are not grouped (c7)", async () => {
  const repo = fixture({
    "src/first.tsx": 'export function Action() { return <button className="customer-action" />; }',
    "src/second.tsx": 'export function Action() { return <button className="admin-action" />; }',
    "src/uses.tsx": 'import { Action as First } from "./first"; import { Action as Second } from "./second"; export function Uses() { return <><First /><Second /></>; }',
  });
  const model = await buildReportModel(repo.dir);
  expect(model.totals.nearDuplicates).toBe(1);
  expect(JSON.stringify(model.projects[0]!.nearDuplicates)).not.toMatch(/src\/(?:first|second)/);
});

test("a token is suggested only when value and group match, the general scale before a component's own token; computed colours are not flagged (c4)", async () => {
  const repo = fixture({
    "src/app/globals.css": '@import "tailwindcss";\n\n@theme {\n  --color-primary: #2563eb;\n  --color-danger: #dc2626;\n  --spacing-button-gap: 8px;\n  --spacing-2: 8px;\n  --radius-card: 12px;\n  --radius-lg: 12px;\n  --radius-dialog: 20px;\n  --color-badge-bg: #16a34a;\n}\n',
    "src/components/list.tsx": 'export function List() { return <ul className="flex gap-[8px] rounded-[12px] bg-[#16a34a] p-[9px]" />; }',
    "src/components/dialog-frame.tsx": 'export function DialogFrame() { return <div className="rounded-[20px]" />; }',
    "src/app/list.css": ".list { gap: 8px; border-radius: 12px; }\n",
    "src/components/hue-strip.tsx": "export function HueStrip({ hue }: { hue: number }) {\n  const swatches = [\"#2563eb\", \"#dc2626\"];\n  return <div style={{ background: `linear-gradient(to right, #2563eb, hsl(${hue} 100% 50%), #dc2626)` }}>{swatches.map((c) => <button key={c} style={{ backgroundColor: c }} />)}</div>;\n}\n",
  });
  const model = await buildReportModel(repo.dir);
  const hardcoded = model.projects[0]!.hardcoded;
  const at = (file: string) => hardcoded.filter((f) => f.sites.some((s) => s.at.startsWith(file)));
  const list = JSON.stringify(at("src/components/list.tsx"));
  expect(list).toContain("spacing.spacing-2");
  expect(list).toContain("radius.radius-lg");
  expect(list).not.toMatch(/button-gap|radius-card|badge-bg|9px/);
  const css = JSON.stringify(at("src/app/list.css"));
  expect(css).toContain("spacing.spacing-2");
  expect(css).toContain("radius.radius-lg");
  expect(css).not.toMatch(/button-gap|radius-card/);
  // No general token holds 20px; the dialog's own token fits a dialog file.
  expect(JSON.stringify(at("src/components/dialog-frame.tsx"))).toContain("radius.radius-dialog");
  expect(at("src/components/hue-strip.tsx")).toEqual([]);
  for (const finding of hardcoded) expect(finding.next).toMatch(/^Use /);
});

test("the console's tokens: the general scale over a phone-only or component token, a token the file already defines, a source over its alias; no token for a value only a phone token holds (c4)", async () => {
  const repo = fixture({
    "src/design/tokens.css": ":root {\n  --so-phone-row: 8px;\n  --so-phone-gap: 12px;\n  --so-phone-block: 14px;\n  --so-radius-card: 10px;\n  --so-radius-md: 8px;\n  --so-radius-sheet: 12px;\n  --so-space-xs: 4px;\n  --so-space-sm: 8px;\n  --so-space-md: 12px;\n  --so-space-lg: 16px;\n}\n",
    "src/design/theme.css": "@theme {\n  --radius-md: var(--so-radius-md);\n  --radius-card: var(--so-radius-card);\n  --spacing-phone-row: var(--so-phone-row);\n  --spacing-phone-gap: var(--so-phone-gap);\n  --spacing-phone-block: var(--so-phone-block);\n}\n",
    "src/browser/workspace.css": ":root { --so-radius: var(--so-radius-card); }\n.list { gap: 8px; }\n.row { margin-top: 12px; }\n.panel { border-radius: 10px; }\n.chip { border-radius: 8px; }\n.block { padding: 14px; }\n.wide { padding: 16px; }\n@media (max-width: 760px) { .card { margin: var(--so-phone-row) 0; padding: var(--so-phone-gap); } }\n",
  });
  const model = await buildReportModel(repo.dir);
  const at = (line: number) => model.projects[0]!.hardcoded.filter((f) => f.sites.some((s) => s.at === `src/browser/workspace.css:${line}`)).map((f) => f.next);
  expect(at(2)).toEqual(["Use gap: var(--so-space-sm) (spacing.so-space-sm) in each place"]);
  expect(at(3)).toEqual(["Use margin-top: var(--so-space-md) (spacing.so-space-md) in each place"]);
  expect(at(4)).toEqual(["Use border-radius: var(--so-radius) (radius.so-radius) in each place"]);
  expect(at(5)).toEqual(["Use border-radius: var(--so-radius-md) (radius.so-radius-md) in each place"]);
  expect(at(6)).toEqual([]);
  expect(at(7)).toEqual(["Use padding: var(--so-space-lg) (spacing.so-space-lg) in each place"]);
  expect(JSON.stringify(model.projects[0]!.hardcoded)).not.toMatch(/phone|radius-card|radius-sheet/);
});
