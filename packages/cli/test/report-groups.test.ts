import { afterEach, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { renderHtml } from "../src/report/html.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import { buildReportModel, type ReportModel } from "../src/report/model.ts";
import { fixtureRepo, monorepoFiles, singleFiles, type FixtureRepo } from "./report-fixtures.ts";

const repos: FixtureRepo[] = [];
const fixture = (prefix: string, files: Record<string, string>) => {
  const repo = fixtureRepo(prefix, files);
  repos.push(repo);
  return repo;
};
afterEach(() => { for (const repo of repos.splice(0)) repo.remove(); });

const SHAPE = "inline-flex h-9 items-center rounded-md px-4 text-sm font-medium";
const TAILWIND = { react: "19.3.0", "react-dom": "19.3.0", tailwindcss: "4.3.3" };

/** dub's shape: a pnpm workspace whose apps import packages/ui by its package name, with no node_modules, plus alias and relative imports of local components. */
function dubFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "dub-like", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "packages/ui/package.json": JSON.stringify({ name: "@dub/ui", main: "./src/index.tsx", dependencies: TAILWIND }),
    "packages/ui/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    "packages/ui/src/index.tsx": 'export * from "./button";\n',
    "packages/ui/src/button.tsx": `export function Button({ className = "", ...props }) {\n  return <button className={\`${SHAPE} \${className}\`} {...props} />;\n}\n`,
    "apps/web/package.json": JSON.stringify({ name: "web", private: true, dependencies: { "@dub/ui": "workspace:*", ...TAILWIND } }),
    "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["./*"] } } }),
    "apps/web/styles/globals.css": '@import "tailwindcss";\n@theme { --color-brand: #7c3aed; }\n',
    "apps/web/ui/shared/icon-button.tsx": `export function IconButton({ className = "", ...props }) {\n  return <button className={\`inline-flex size-8 items-center rounded-lg \${className}\`} {...props} />;\n}\n`,
    "apps/web/ui/shared/chip.tsx": `export function Chip({ className = "", ...props }) {\n  return <button className={\`h-6 px-2 rounded-full text-xs \${className}\`} {...props} />;\n}\n`,
  };
  const classes = ["h-9 px-4 rounded-md text-sm", "h-8 w-full rounded-lg px-3", "h-10 px-6 rounded-xl text-base"];
  for (let i = 0; i < 9; i++) {
    files[`apps/web/ui/screens/screen-${i}.tsx`] = [
      'import { Button } from "@dub/ui";',
      'import { IconButton } from "@/ui/shared/icon-button";',
      'import { Chip } from "../shared/chip";',
      `export function Screen${i}() {`,
      `  return <div><Button className="${classes[i % 3]}" variant="primary">Go</Button><Button text="Save" /><IconButton className="${classes[(i + 1) % 3]}" /><Chip className="${classes[(i + 2) % 3]}" /></div>;`,
      "}",
      "",
    ].join("\n");
  }
  return files;
}

/** Two near-copy buttons in different files, and copies a story, a showcase folder and route files hold. */
function copiesFiles(): Record<string, string> {
  const component = (name: string) => `export function ${name}(props) {\n  return <button type="button" className="${SHAPE}" {...props} />;\n}\n`;
  return {
    "package.json": JSON.stringify({ name: "copies", private: true, dependencies: { ...TAILWIND, next: "15.0.0" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    "src/app/globals.css": '@import "tailwindcss";\n',
    "src/components/primary-button.tsx": component("PrimaryButton"),
    "src/features/billing/submit-button.tsx": component("SubmitButton"),
    "src/components/primary-button.stories.tsx": `import { PrimaryButton } from "./primary-button";\nexport default { component: PrimaryButton };\n${component("StoryButton")}export const Default = () => <StoryButton />;\n`,
    "src/examples/demo-button.tsx": component("DemoButton") + 'export function Demo() { return <DemoButton />; }\n',
    "src/app/api/route.ts": "export function GET() { return Response.json({}); }\nexport function POST() { return Response.json({}); }\n",
    "src/app/layout.tsx": 'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
    "src/app/page.tsx": 'import { PrimaryButton } from "../components/primary-button";\nimport { SubmitButton } from "../features/billing/submit-button";\nexport default function Page() { return <main><PrimaryButton>Buy</PrimaryButton><SubmitButton>Pay</SubmitButton></main>; }\n',
  };
}

/** Hand-styled buttons in three files; a keeper and its copy in one file; optionally a shared Button with a different shape. */
function handStyledFiles(shared: boolean): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "hand-styled", private: true, dependencies: TAILWIND }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    "src/styles.css": '@import "tailwindcss";\n',
    "src/widgets/toolbar.tsx": `export function Toolbar() { return <div><button className="h-7 px-2 rounded text-xs">Undo</button><button className="h-7 px-2 rounded text-xs">Redo</button></div>; }\n`,
    "src/widgets/footer.tsx": `export function Footer() { return <footer><button className="h-7 px-2 rounded text-xs">Top</button></footer>; }\n`,
    "src/widgets/header.tsx": `export function Header() { return <header><button className="h-7 px-2 rounded text-xs">Menu</button></header>; }\n`,
    "src/widgets/pair.tsx": `export function BigButton(props) { return <button className="h-12 px-6 rounded-full text-lg" {...props} />; }\nexport function Promo() {\n  return <section><button className="h-12 px-6 rounded-full text-lg">Join</button></section>;\n}\n`,
    "src/widgets/large-button.tsx": `export function LargeButton(props) { return <button className="h-12 px-6 rounded-full text-lg" {...props} />; }\n`,
    "src/app.tsx": 'import { Toolbar } from "./widgets/toolbar";\nimport { Footer } from "./widgets/footer";\nimport { Header } from "./widgets/header";\nimport { BigButton, Promo } from "./widgets/pair";\nimport { LargeButton } from "./widgets/large-button";\nexport function App() { return <><Header /><Toolbar /><Footer /><BigButton /><BigButton /><Promo /><LargeButton /></>; }\n',
  };
  if (shared) {
    files["src/components/ui/button.tsx"] = `export function Button(props) { return <button className="${SHAPE}" {...props} />; }\n`;
    files["src/app.tsx"] = files["src/app.tsx"]!.replace("export function App() { return <>", 'import { Button } from "@/components/ui/button";\nexport function App() { return <><Button />');
  }
  return files;
}

/** Every near-duplicate fix: its keeper file is not a file it applies to, and every import it suggests resolves to the keeper. */
function expectSoundFixes(model: ReportModel, dir: string): void {
  for (const group of model.projects.flatMap((p) => p.nearDuplicates)) {
    const keeper = /^(?:Keep (?:one )?\S+ \(([^)]+)\)|Create \S+ in (\S+) \(a new file)/.exec(group.next);
    expect(keeper, group.next).not.toBeNull();
    const keeperFile = (keeper![1] ?? keeper![2]!).split(", ").at(-1)!;
    const steps = (group.steps ?? []).join("\n");
    const targets = [...steps.matchAll(/^In ([^,]+), /gm)].map((m) => m[1]!);
    expect(targets.length, group.next).toBeGreaterThan(0);
    expect(targets.length, group.next).toBe(group.steps!.length);
    for (const target of targets) expect(target, group.next).not.toBe(keeperFile);
    for (const site of group.sites) expect(site.at.replace(/:\d+$/, "")).not.toBe(keeperFile);
    for (const [, from, specifier] of steps.matchAll(/^In ([^,]+), .+? \(import \{ \S+ \} from "([^"]+)"\)$/gm)) {
      // A workspace package's name (no node_modules to resolve it): the keeper must be that package's.
      const owner = keeperFile.split("/").slice(0, 2).join("/");
      const pkg = existsSync(join(dir, owner, "package.json")) ? (JSON.parse(readFileSync(join(dir, owner, "package.json"), "utf8")) as { name?: string }).name : undefined;
      if (pkg && specifier === pkg) {
        expect(from!.startsWith(`${owner}/`), group.next).toBe(false);
        continue;
      }
      let configDir = dirname(join(dir, from!));
      while (!existsSync(join(configDir, "tsconfig.json")) && configDir !== dir) configDir = dirname(configDir);
      const config = ts.parseJsonConfigFileContent(JSON.parse(readFileSync(join(configDir, "tsconfig.json"), "utf8")), ts.sys, configDir).options;
      expect(ts.resolveModuleName(specifier!, join(dir, from!), config, ts.sys).resolvedModule?.resolvedFileName, group.next).toBe(join(dir, keeperFile));
    }
  }
}

test("uses of one imported component never form a group: package, alias and relative imports, no node_modules (c1)", async () => {
  const repo = fixture("dub", dubFiles());
  const model = await buildReportModel(repo.dir);
  expect(model.projects.map((p) => p.dir).sort()).toEqual(["apps/web", "packages/ui"]);
  expect(model.projects.flatMap((p) => p.nearDuplicates)).toEqual([]);
  expect(model.totals.nearDuplicates).toBe(0);
  expect(model.summary.join("\n")).toContain("Near-duplicates: 0 groups");
});

test("two near-copy components in different files make exactly one group naming both; stories, showcase and route exports stay out (c2)", async () => {
  const repo = fixture("copies", copiesFiles());
  const model = await buildReportModel(repo.dir);
  const groups = model.projects.flatMap((p) => p.nearDuplicates);
  expect(groups).toHaveLength(1);
  expect(model.totals.nearDuplicates).toBe(1);
  const text = JSON.stringify(groups[0]);
  expect(text).toContain("PrimaryButton");
  expect(text).toContain("SubmitButton");
  expect(text).toContain("src/components/primary-button.tsx");
  expect(text).toContain("src/features/billing/submit-button.tsx");
  expect(text).not.toMatch(/StoryButton|DemoButton|stories|examples|route\.ts|GET|POST|Layout|Page\b/);
  expectSoundFixes(model, repo.dir);
});

test("hand-styled groups name an existing shared component, or a new file to extract into; never the file a fix applies to (c3)", async () => {
  const extract = fixture("hand", handStyledFiles(false));
  const model = await buildReportModel(extract.dir);
  const buttons = model.projects[0]!.nearDuplicates.find((g) => g.title.includes("button"));
  // No shared UI folder exists: the new file goes in the folder the copies already share, never an invented components/ui.
  expect(buttons?.next).toMatch(/^Create Button in src\/widgets\/button\.tsx \(a new file in the folder its copies share\)/);
  expect(buttons?.next).toContain("In src/widgets/toolbar.tsx, replace the hand-styled <button>");
  expect(buttons?.next).toContain("In src/widgets/footer.tsx");
  expect(buttons?.next).toContain("In src/widgets/header.tsx");
  // Promo's hand-styled copy shares the keeper's file: it is never told to reuse BigButton from its own file.
  const big = model.projects[0]!.nearDuplicates.find((g) => g.title.includes("48px high"));
  expect(big?.next).toMatch(/^Keep BigButton \(src\/widgets\/pair\.tsx\)\. In src\/widgets\/large-button\.tsx, build LargeButton on BigButton instead of restyling its own element \(import \{ BigButton \} from "/);
  expect(big?.next).not.toContain("In src/widgets/pair.tsx");
  expectSoundFixes(model, extract.dir);

  const shared = fixture("hand-shared", handStyledFiles(true));
  const withShared = await buildReportModel(shared.dir);
  const named = withShared.projects[0]!.nearDuplicates.find((g) => g.title.includes("button"));
  expect(named?.next).toMatch(/^Keep Button \(src\/components\/ui\/button\.tsx\)/);
  expect(named?.next).toContain('import { Button } from "@/components/ui/button"');
  expectSoundFixes(withShared, shared.dir);
});

test("across every report fixture no fix is self-referential and every suggested import resolves (c3)", async () => {
  for (const [name, files] of Object.entries({ single: singleFiles(), monorepo: monorepoFiles(), dub: dubFiles(), copies: copiesFiles(), hand: handStyledFiles(false), shared: handStyledFiles(true) })) {
    const repo = fixture(name, files);
    expectSoundFixes(await buildReportModel(repo.dir), repo.dir);
  }
}, 60_000);

const INPUT_CLASSES = "w-full max-w-md rounded-md border border-neutral-300 text-neutral-900 sm:text-sm";

/** dub's top group: @dub/ui exports Input; packages/ui/src/form.tsx hand-styles the same input; apps/web has a popover-specific input used everywhere, hand-styled inputs and hand-styled selects. No node_modules, no apps/web/components. */
function keeperFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "dub-keeper", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "packages/ui/package.json": JSON.stringify({ name: "@dub/ui", main: "./dist/index.js", dependencies: TAILWIND }),
    "packages/ui/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    "packages/ui/src/index.tsx": 'export * from "./input";\nexport * from "./form";\n',
    "packages/ui/src/input.tsx": `import React from "react";\nexport const Input = React.forwardRef(({ className, ...props }, ref) => (\n  <div><div className="relative flex"><input ref={ref} className={\`${INPUT_CLASSES} \${className}\`} {...props} /></div></div>\n));\n`,
    "packages/ui/src/form.tsx": `export function Form({ title }) {\n  return <form><h2>{title}</h2><input className="${INPUT_CLASSES}" /></form>;\n}\n`,
    "apps/web/package.json": JSON.stringify({ name: "web", private: true, dependencies: { "@dub/ui": "workspace:*", ...TAILWIND } }),
    "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["./*"] } } }),
    "apps/web/styles/globals.css": '@import "tailwindcss";\n',
    "apps/web/ui/shared/inline-badge-popover.tsx": `export function InlineBadgePopoverInput(props) {\n  return <input className="${INPUT_CLASSES}" {...props} />;\n}\n`,
  };
  for (let i = 0; i < 6; i++) {
    files[`apps/web/ui/screens/screen-${i}.tsx`] = [
      'import { Input } from "@dub/ui";',
      'import { InlineBadgePopoverInput } from "@/ui/shared/inline-badge-popover";',
      `export function Screen${i}() {`,
      `  return <div><Input name="a" /><InlineBadgePopoverInput /><InlineBadgePopoverInput /><input className="${INPUT_CLASSES}" />${i < 2 ? '<select className="h-9 rounded-md border px-3 text-sm"><option>a</option></select>' : ""}</div>;`,
      "}",
      "",
    ].join("\n");
  }
  return files;
}

test("a group keeps the shared UI package's general component, never an app's feature component; a shared library never imports from an app; a <select> group extracts a Select into the existing UI package (c1)", async () => {
  const repo = fixture("keeper", keeperFiles());
  const model = await buildReportModel(repo.dir);
  const groups = model.projects.flatMap((p) => p.nearDuplicates);
  const inputs = groups.find((g) => /\binputs look the same/.test(g.title));
  expect(inputs?.lead).toBe("Keep Input (@dub/ui, packages/ui/src/input.tsx)");
  expect(inputs?.steps).toContain('In packages/ui/src/form.tsx, replace the hand-styled <input> at line 2 with Input (import { Input } from "./input")');
  expect(inputs?.steps).toContain('In apps/web/ui/shared/inline-badge-popover.tsx, build InlineBadgePopoverInput on Input instead of restyling its own element (import { Input } from "@dub/ui")');
  const selects = groups.find((g) => /\bselects look the same/.test(g.title));
  expect(selects?.lead).toBe("Create Select in packages/ui/src/select.tsx (a new file in @dub/ui, the shared UI package) with this shape");
  expect(existsSync(join(repo.dir, "packages/ui/src"))).toBe(true);
  for (const group of groups) {
    // A shared library file is never told to use an app's component; nothing names a folder that does not exist.
    for (const step of group.steps ?? []) if (step.startsWith("In packages/")) expect(step, step).not.toMatch(/apps\//);
    expect(group.next).not.toMatch(/InlineBadgePopoverInput \(|Keep InlineBadgePopoverInput|components\/ui/);
    if (/selects look the same/.test(group.title)) expect(group.next).not.toMatch(/\bInput\b/);
  }
  expectSoundFixes(model, repo.dir);
});

test("a fix lists five files and folds the rest: the summary line, the HTML and the Markdown stay short (c2)", async () => {
  const files: Record<string, string> = { ...handStyledFiles(true) };
  for (let i = 0; i < 9; i++) files[`src/screens/screen-${i}.tsx`] = `export function Screen${i}() { return <div><button className="${SHAPE}">Go</button></div>; }\n`;
  const repo = fixture("long", files);
  const model = await buildReportModel(repo.dir);
  const top = model.topFixes[0]!;
  expect(top.steps!.length).toBeGreaterThan(5);
  expect(top.next.match(/\bIn src\//g)).toHaveLength(5);
  expect(top.next).toContain(`and ${top.steps!.length - 5} more files (listed in the report)`);
  expect(model.summary[4]).toBe(`Top fix: ${top.title}; keep Button (src/components/ui/button.tsx), then change ${top.steps!.length} files (each listed in the report).`);
  const html = renderHtml(model);
  const item = html.slice(html.indexOf('data-section="top-fixes"'), html.indexOf("</li>", html.indexOf("<details", html.indexOf('data-section="top-fixes"'))));
  expect(item.slice(0, item.indexOf("<details")).match(/<li>In /g)).toHaveLength(5);
  expect(item).toContain(`<details class="more"><summary>and ${top.steps!.length - 5} more files</summary><ol class="steps" start="6">`);
  const md = renderMarkdown(model, "youiyoux-report.html");
  expect(md).toContain(`   - and ${top.steps!.length - 5} more files, listed in the report`);
});

/** Same-named components: near-copies across two wizards, a name collision, generic names, a private copy, and the exclusions. */
function twinFiles(): Record<string, string> {
  const step = (label: string, fields: string[]) => `import { Field, TextInput } from "../../ui";\nexport function IdentityStep({ controller }) {\n  const { state, setField } = controller;\n  return (\n    <div className="grid gap-4">\n${fields.map((f) => `      <Field label="${label}"><TextInput name="${f}" value={state.${f}} onValueChange={(v) => setField("${f}", v)} invalid={state.errors.${f} !== undefined} /></Field>`).join("\n")}\n    </div>\n  );\n}\n`;
  const header = (body: string) => `export function Header() { return ${body}; }\n`;
  const slider = 'function TrafficSplitSlider({ value, onChange }) {\n  const [drag, setDrag] = useState(false);\n  return <div className="relative h-2"><div className="absolute inset-0" style={{ width: value }} /><input type="range" value={value} onChange={(e) => onChange(e.target.value)} onPointerDown={() => setDrag(true)} /></div>;\n}\n';
  return {
    "package.json": JSON.stringify({ name: "twins", private: true, dependencies: { ...TAILWIND, next: "15.0.0" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    "src/ui.tsx": "export function Field({ label, children }) { return <label>{label}{children}</label>; }\nexport function TextInput(props) { return <input {...props} />; }\n",
    "src/brief/steps/IdentityStep.tsx": step("Name", ["firstName", "lastName", "email"]),
    "src/partner/steps/IdentityStep.tsx": step("Name", ["name", "email"]),
    "src/files/DropZone.tsx": 'export function DropZone({ onFiles }) {\n  const { getRootProps, getInputProps, isDragActive } = useDropzone({ multiple: true, onDrop: onFiles });\n  return <div {...getRootProps()}>{isDragActive && <><input {...getInputProps()} /><Icon /><p>Upload files</p></>}</div>;\n}\n',
    "src/import/DropZone.tsx": 'export function DropZone({ onContinue }) {\n  const [loading, setLoading] = useState(false);\n  const toast = useToast();\n  const { getRootProps, getInputProps, open } = useDropzone({ maxFiles: 1, onDropRejected: (r) => r.forEach((x) => toast(x)), onDropAccepted: async ([f]) => { setLoading(true); onContinue(await read(f)); } });\n  return <section {...getRootProps()}><input {...getInputProps()} />{loading ? <p>Processing</p> : <><p>Upload a sheet</p><button onClick={open}>Select file</button><button>Sample</button></>}</section>;\n}\n',
    "src/a/Header.tsx": header('<header className="flex h-12 items-center"><h1>A</h1><nav><a href="/">Home</a></nav></header>'),
    "src/b/Header.tsx": header('<div className="grid"><span>B</span></div>'),
    "src/a/Footer.tsx": 'export function Footer() { return <footer className="border-t p-4"><p>One</p><a href="/x">X</a><a href="/y">Y</a></footer>; }\n',
    "src/b/Footer.tsx": 'export function Footer() { return <footer className="border-t p-4"><p>Two</p><a href="/x">X</a><a href="/y">Y</a></footer>; }\n',
    "src/links/ab-testing-modal.tsx": `${slider}export function useModal() { return <TrafficSplitSlider value={1} onChange={() => {}} />; }\n`,
    "src/links/ab-testing/traffic-split-slider.tsx": `export ${slider}`,
    "src/files/DropZone.stories.tsx": 'export function DropZone() { return <div className="p-4"><input /><p>Story</p><p>Copy</p></div>; }\n',
    "src/examples/IdentityStep.tsx": step("Name", ["firstName", "lastName", "email"]),
    "src/app/one/page.tsx": 'export default function Page() { return <main className="p-4"><h1>One</h1><p>Text</p></main>; }\n',
    "src/app/two/page.tsx": 'export default function Page() { return <main className="p-4"><h1>One</h1><p>Text</p></main>; }\n',
    "src/app/one/route.ts": "export function GET() { return Response.json({}); }\n",
    "src/app/two/route.ts": "export function GET() { return Response.json({}); }\n",
  };
}

test("same-named components: near-copies, a shared name, a private copy, and generic names only when structurally the same; stories, examples and routes never (c3)", async () => {
  const repo = fixture("twins", twinFiles());
  const model = await buildReportModel(repo.dir);
  const groups = model.projects.flatMap((p) => p.nearDuplicates);
  const byName = (name: string) => groups.filter((g) => g.title.startsWith(`${name} is defined in`));
  expect(byName("IdentityStep").map((g) => g.title)).toEqual(["IdentityStep is defined in 2 files with near-identical structure"]);
  expect(byName("IdentityStep")[0]!.lead).toMatch(/^Keep one IdentityStep \(src\/(?:brief|partner)\/steps\/IdentityStep\.tsx\) that takes what differs as props$/);
  expect(JSON.stringify(byName("IdentityStep"))).not.toContain("examples");
  expect(byName("DropZone").map((g) => g.title)).toEqual(["DropZone is defined in 2 files as different components"]);
  expect(JSON.stringify(byName("DropZone"))).not.toContain("stories");
  expect(byName("TrafficSplitSlider").map((g) => g.title)).toEqual(["TrafficSplitSlider is defined in 2 files with the same structure"]);
  expect(byName("TrafficSplitSlider")[0]!.steps).toEqual(['In src/links/ab-testing-modal.tsx, delete its TrafficSplitSlider and use the kept one (import { TrafficSplitSlider } from "./ab-testing/traffic-split-slider")']);
  expect(byName("Footer")).toHaveLength(1);
  expect(byName("Header")).toEqual([]);
  expect(byName("Page")).toEqual([]);
  expect(JSON.stringify(groups)).not.toMatch(/route\.ts|GET/);
});
