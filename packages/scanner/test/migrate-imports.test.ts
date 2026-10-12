import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MigrationSpec } from "@youiyoux/core";
import { afterEach, describe, expect, test } from "vitest";
import { loadProject, runMigration, scanProject, verifyRewrite } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");

const spec = (changes: unknown[], component = "card"): MigrationSpec =>
  MigrationSpec.parse({ schema: "youi.migration/v1", id: `youi:demo/migration/${component}-2.0.0`, element: `youi:demo/component/${component}`, from: "1.x", to: "2.0.0", changes });
const renameCard = spec([{ renameExport: { from: "Card", to: "Panel" } }]);
const renameCardAndBarrels = spec([{ renameExport: { from: "Card", to: "Panel", renameBarrels: true } }]);

interface DesignChange {
  /** The component whose file changes (default card). */
  readonly component?: "card" | "button";
  /** Export renames in its file (old → new, or null to remove an exported function). */
  readonly exports: Readonly<Record<string, string | null>>;
}

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Copies of examples/demo-design and examples/demo-app, side by side (the app's source.path
 * stays valid). The design's component file and contract take the change; with `synced`, the
 * app's vendored copy does too, as `youi sync` would leave it.
 */
async function setup(change: DesignChange, options: { synced?: boolean; files?: Record<string, string> } = {}): Promise<{ app: string; design: string }> {
  const dir = await mkdtemp(join(tmpdir(), "youi-migrate-imports-"));
  temps.push(dir);
  const app = join(dir, "demo-app");
  const design = join(dir, "demo-design");
  await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), design, { recursive: true });
  const component = change.component ?? "card";
  const file = `components/${component}/${component}.tsx`;
  let source = await readFile(join(design, file), "utf8");
  const contractFile = join(design, `components/${component}/${component}.contract.json`);
  const contract = JSON.parse(await readFile(contractFile, "utf8")) as { source: { export: string; also: string[] }; aliases: string[] };
  const swap = (names: string[], from: string, to: string | null): string[] => names.flatMap((name) => (name !== from ? [name] : to === null ? [] : [to]));
  for (const [from, to] of Object.entries(change.exports)) {
    if (to === null) source = source.replace(new RegExp(`\\nexport function ${from}\\([\\s\\S]*?\\n}\\n`), "\n");
    else source = source.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    if (contract.source.export === from) contract.source.export = to!;
    contract.source.also = swap(contract.source.also, from, to);
    contract.aliases = swap(contract.aliases, from, to);
  }
  await writeFile(join(design, file), source);
  await writeFile(contractFile, `${JSON.stringify(contract, null, 2)}\n`);
  if (options.synced !== false) await writeFile(join(app, `components/ui/${component}.tsx`), source);
  for (const [file, text] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(app, file)), { recursive: true });
    await writeFile(join(app, file), text);
  }
  return { app, design };
}

/** Every file in the app, by content: proof that a run wrote nothing. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)));
}

const CASES = {
  // Aliased: the local keeps its name, only the imported name changes.
  "components/aliased.tsx": `import { Card as Box, CardHeader } from "@/components/ui";\n\nexport function Aliased() {\n  return <Box><CardHeader /></Box>;\n}\n`,
  // A product barrel: a same-name re-export and one as default.
  "components/cards.ts": `export { Card } from "./ui/card";\nexport { Card as default, CardTitle } from "./ui/card";\n`,
  // Through the product barrel: named, and a default import whose local is the old name.
  "components/via-barrel.tsx": `import Card from "@/components/cards";\nimport { Card as Named } from "@/components/cards";\n\nexport const Pair = () => <Card><Named /></Card>;\n`,
  // Type-only: statement-level and specifier-level, used in types only.
  "components/typed.tsx": `import type { Card } from "@/components/ui";\nimport { type Card as CardFn, CardHeader } from "@/components/ui";\n\nexport type CardElement = ReturnType<typeof Card>;\nexport type Same = typeof CardFn;\nexport const header = CardHeader;\n`,
  // A namespace import used only through static members.
  "components/namespaced.tsx": `import * as ui from "@/components/ui";\n\nexport const Box = () => <ui.Card><ui.CardHeader /></ui.Card>;\nexport const card: typeof ui.Card = ui.Card;\n`,
  // A lookalike: its own Card, never the design system's.
  "components/legacy/card.tsx": `export function Card() {\n  return null;\n}\n`,
  "components/legacy-use.tsx": `import { Card } from "@/components/legacy/card";\n\nexport const Old = () => <Card />;\n`,
};

const AMBIGUOUS = {
  "components/shadow.tsx": `import { Card, CardHeader } from "@/components/ui";\n\nexport function Wrap({ Card: Inner }: { Card: typeof Card }) {\n  const render = (Card: () => null) => <Card />;\n  return <CardHeader>{render(() => null)}<Inner /></CardHeader>;\n}\n`,
  "components/clash.tsx": `import { Card } from "@/components/ui";\n\nconst Panel = "panel";\nexport const Clash = () => <Card className={Panel} />;\n`,
  "components/dynamic.tsx": `import * as ui from "@/components/ui";\n\nexport const names = Object.keys(ui);\nexport const Dynamic = () => <ui.Card />;\n`,
};

describe("renameExport", () => {
  test("rewrites named, aliased, default, barrel, type-only and namespace imports and their uses; every gate passes; nothing is written", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: CASES });
    const before = await snapshot(app);
    const result = await runMigration(await loadProject(app), renameCard);
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.status).toBe("dry-run");
    expect(result.gates.map((g) => [g.name, g.ok])).toEqual([["coverage", true], ["exports", true], ["imports-resolve", true], ["parse-errors", true], ["usage-count", true], ["unknowns", true], ["old-api", true], ["idempotent", true]]);
    expect(result.residuals).toEqual([]);
    const after = Object.fromEntries(result.changes.map((c) => [c.file, c.after]));
    expect(Object.keys(after).sort()).toEqual(["app/index.tsx", "app/settings/index.tsx", "components/aliased.tsx", "components/cards.ts", "components/invite-form.tsx", "components/namespaced.tsx", "components/typed.tsx"]);
    // Named: the specifier and every JSX tag, closing tags included.
    expect(result.changes.find((c) => c.file === "app/index.tsx")!.diff).toBe(
      [
        "--- a/app/index.tsx",
        "+++ b/app/index.tsx",
        "@@ -1,4 +1,4 @@",
        '-import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";',
        '+import { Button, Panel, CardContent, CardHeader, CardTitle } from "@/components/ui";',
        " ",
        " const projects = [",
        '   { name: "Atlas", detail: "3 members · updated today" },',
        "@@ -13,13 +13,13 @@",
        "         <Button>New project</Button>",
        "       </div>",
        "       {projects.map((project) => (",
        "-        <Card key={project.name}>",
        "+        <Panel key={project.name}>",
        "           <CardHeader>",
        "             <CardTitle>{project.name}</CardTitle>",
        '             <Button variant="outline" size="sm">Open</Button>',
        "           </CardHeader>",
        "           <CardContent>{project.detail}</CardContent>",
        "-        </Card>",
        "+        </Panel>",
        "       ))}",
        '       <div className="rounded-[12px] border border-line p-4 text-muted">Archived projects appear here.</div>',
        "     </div>",
        "",
      ].join("\n"),
    );
    // Aliased: the local name stays.
    expect(after["components/aliased.tsx"]).toBe(CASES["components/aliased.tsx"].replace("Card as Box", "Panel as Box"));
    // Barrel re-exports, `as default` included, other specifiers untouched.
    expect(after["components/cards.ts"]).toBe(`export { Panel as Card } from "./ui/card";\nexport { Panel as default, CardTitle } from "./ui/card";\n`);
    // The barrel keeps its public names, including default; its consumers stay unchanged.
    expect(after["components/via-barrel.tsx"]).toBeUndefined();
    // Type-only: `type` kept at statement and specifier level; type uses renamed.
    expect(after["components/typed.tsx"]).toBe(`import type { Panel } from "@/components/ui";\nimport { type Panel as CardFn, CardHeader } from "@/components/ui";\n\nexport type CardElement = ReturnType<typeof Panel>;\nexport type Same = typeof CardFn;\nexport const header = CardHeader;\n`);
    // Namespace members: JSX tags, values and `typeof ui.Card`.
    expect(after["components/namespaced.tsx"]).toBe(`import * as ui from "@/components/ui";\n\nexport const Box = () => <ui.Panel><ui.CardHeader /></ui.Panel>;\nexport const card: typeof ui.Panel = ui.Panel;\n`);
    // The lookalike resolves elsewhere and is left alone.
    expect(after["components/legacy-use.tsx"]).toBeUndefined();
    // Sites the old name hid from the scan count again after the rewrite.
    expect(result.sitesAfter).toBeGreaterThan(result.sitesBefore);
    expect(await snapshot(app)).toEqual(before);
  });

  test("--write applies it, the rescan sees every Panel, and a second run is a no-op", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: CASES });
    const project = await loadProject(app);
    const applied = await runMigration(project, renameCard, { write: true });
    expect(applied.status).toBe("applied");
    expect(await readFile(join(app, "app/settings/index.tsx"), "utf8")).not.toMatch(/\bCard\b(?!Header|Title|Content)/);
    const rescan = await scanProject(project);
    expect(rescan.report.usages.filter((u) => u.element === renameCard.element)).toHaveLength(applied.sitesAfter);
    expect(rescan.report.unknowns.filter((u) => u.name === "Card")).toEqual([]);
    const again = await runMigration(project, renameCard);
    expect(again).toMatchObject({ status: "noop", changes: [], residuals: [] });
  });

  test("ambiguous files are left unchanged and reported with file:line and why; the rest is rewritten", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: AMBIGUOUS });
    const before = await snapshot(app);
    const result = await runMigration(await loadProject(app), renameCard);
    expect(result.status).toBe("dry-run");
    expect(result.gates.every((g) => g.ok)).toBe(true);
    const changed = result.changes.map((c) => c.file);
    for (const file of Object.keys(AMBIGUOUS)) expect(changed).not.toContain(file);
    expect(changed).toContain("app/index.tsx");
    expect(result.residuals.map((r) => `${r.file}:${r.line} ${r.reason}`).sort()).toEqual([
      "components/clash.tsx:1 not rewritten: Panel is already used at line 3",
      "components/clash.tsx:3 not rewritten: Panel is already used at line 3",
      "components/clash.tsx:4 not rewritten: Panel is already used at line 4",
      "components/dynamic.tsx:3 not rewritten: namespace ui is used dynamically at line 3, so its uses of Card cannot be traced",
      "components/dynamic.tsx:4 not rewritten: namespace ui is used dynamically at line 3, so its uses of Card cannot be traced",
      "components/shadow.tsx:1 not rewritten: local Card is re-declared at line 4",
      "components/shadow.tsx:4 not rewritten: local Card is re-declared at line 4",
    ]);
    expect(await snapshot(app)).toEqual(before);
  });

  test("before youi sync the exports gate rejects: the vendored file does not export the new name yet", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { synced: false });
    const before = await snapshot(app);
    const result = await runMigration(await loadProject(app), renameCard, { write: true });
    expect(result.status).toBe("rejected");
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.gates.find((g) => g.name === "exports")).toEqual({ name: "exports", ok: false, detail: "components/ui/card.tsx does not export Panel yet: run youi sync, then migrate" });
    expect(await snapshot(app)).toEqual(before);
  });
});

describe("gates on an import rewrite", () => {
  test("a rewrite that misses a use or leaves an old import is caught, and nothing is written", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } });
    const project = await loadProject(app);
    const before = await scanProject(project);
    const home = before.modules.get("app/index.tsx")!.source;
    // Import renamed but the JSX left on the old name: the tags no longer resolve.
    const missedUse = home.replace("Button, Card,", "Button, Panel,");
    const { gates } = await verifyRewrite(project, renameCard, before, new Map([["app/index.tsx", missedUse]]));
    expect(gates.find((g) => g.name === "parse-errors")?.ok).toBe(true);
    expect(gates.find((g) => g.name === "usage-count")).toMatchObject({ ok: false });
    // Only the tags renamed: the old import stays, so the old-api and idempotence gates fail.
    const oldImport = home.replace(/<(\/?)Card\b/g, "<$1Panel");
    const second = await verifyRewrite(project, renameCard, before, new Map([["app/index.tsx", oldImport]]));
    expect(second.gates.find((g) => g.name === "old-api")).toMatchObject({ ok: false, detail: expect.stringContaining("app/index.tsx:1") });
    expect(second.gates.find((g) => g.name === "idempotent")).toMatchObject({ ok: false });
  });
});

describe("removeExport", () => {
  test("with a declared replacement, imports and uses move to it", async () => {
    const { app } = await setup({ exports: { CardTitle: "CardHeading" } });
    const result = await runMigration(await loadProject(app), spec([{ removeExport: { name: "CardTitle", replacement: "CardHeading" } }]));
    expect(result.status).toBe("dry-run");
    expect(result.gates.every((g) => g.ok)).toBe(true);
    expect(result.residuals).toEqual([]);
    expect(result.changes.map((c) => c.file).sort()).toEqual(["app/index.tsx", "app/settings/index.tsx", "components/invite-form.tsx"]);
    expect(result.changes.find((c) => c.file === "components/invite-form.tsx")!.diff).toBe(
      [
        "--- a/components/invite-form.tsx",
        "+++ b/components/invite-form.tsx",
        "@@ -1,10 +1,10 @@",
        '-import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";',
        '+import { Button, Card, CardContent, CardHeader, CardHeading, Input } from "@/components/ui";',
        " ",
        " export function InviteForm() {",
        "   return (",
        "     <Card>",
        "       <CardHeader>",
        "-        <CardTitle>Invite people</CardTitle>",
        "+        <CardHeading>Invite people</CardHeading>",
        "       </CardHeader>",
        "       <CardContent>",
        '         <label htmlFor="email">Email</label>',
        "",
      ].join("\n"),
    );
  });

  test("a variants function moved to its replacement keeps its calls counted", async () => {
    const files = { "components/link-button.tsx": `import { buttonVariants } from "@/components/ui";\n\nexport const LinkButton = () => <a className={buttonVariants({ variant: "ghost" })} href="/" />;\nexport const classes = [buttonVariants(), buttonVariants({ size: "sm" })];\n` };
    const { app } = await setup({ component: "button", exports: { buttonVariants: "actionVariants" } }, { files });
    const result = await runMigration(await loadProject(app), spec([{ removeExport: { name: "buttonVariants", replacement: "actionVariants" } }], "button"));
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.gates.find((g) => g.name === "usage-count")?.detail).toContain("(3 resolvable again under the new name)");
    expect(result.changes.map((c) => c.after)).toEqual([files["components/link-button.tsx"].replaceAll("buttonVariants", "actionVariants")]);
  });

  test("without a replacement, every import is reported with file:line and no file changes", async () => {
    const { app } = await setup({ exports: { CardContent: null } });
    const before = await snapshot(app);
    const result = await runMigration(await loadProject(app), spec([{ removeExport: { name: "CardContent" } }]), { write: true });
    expect(result.status).toBe("noop");
    expect(result.changes).toEqual([]);
    const reason = "imports CardContent, which Card's components/ui/card.tsx no longer exports; the migration declares no replacement";
    expect(result.residuals.map((r) => `${r.file}:${r.line}:${r.column} ${r.reason}`)).toEqual([
      `app/index.tsx:1:${'import { Button, Card, '.length + 1} ${reason}`,
      `app/settings/index.tsx:1:${'import { Button, Card, '.length + 1} ${reason}`,
      `components/invite-form.tsx:1:${'import { Button, Card, '.length + 1} ${reason}`,
    ]);
    expect(await snapshot(app)).toEqual(before);
  });

  test("a removal without replacement holds the whole file, so a rename in it is reported, not half-applied", async () => {
    const { app } = await setup({ exports: { Card: "Panel", CardContent: null } });
    const before = await snapshot(app);
    const result = await runMigration(await loadProject(app), spec([{ renameExport: { from: "Card", to: "Panel" } }, { removeExport: { name: "CardContent" } }]));
    expect(result.status).toBe("noop");
    const home = result.residuals.filter((r) => r.file === "app/index.tsx").map((r) => r.reason);
    expect(home).toEqual(["not rewritten: CardContent is imported at line 1 and removed with no replacement", expect.stringContaining("imports CardContent")]);
    expect(await snapshot(app)).toEqual(before);
  });
});

test("migration specs without export changes keep their gates, and the new kinds validate their names", () => {
  expect(() => spec([{ renameExport: { from: "Card", to: "Card" } }])).toThrow();
  expect(() => spec([{ renameExport: { from: "Card", to: "Pan el" } }])).toThrow();
  expect(() => spec([{ removeExport: { name: "Card", replacement: "Card" } }])).toThrow();
  expect(spec([{ removeExport: { name: "CardContent" } }]).changes).toEqual([{ removeExport: { name: "CardContent" } }]);
});

describe("import rewrite review regressions", () => {

  test("qualified external and global members stay unchanged beside renamed locals", async () => {
    const members = 'import type * as R from "react";\ntype X = R.Card;\ntype Y = MyGlobal.Card;\ntype Z = R.Panel;\ntype Nested = MyGlobal.Sub.Card;\n';
    const file = "components/qualified.ts";
    const mixed = "components/qualified-mixed.ts";
    const local = 'import { Card } from "./ui/card";\nexport const card = Card;\n';
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: { [file]: members, [mixed]: local + members } });
    const result = await runMigration(await loadProject(app), renameCard, { write: true });
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.residuals).toEqual([]);
    expect(await readFile(join(app, file), "utf8")).toBe(members);
    expect(await readFile(join(app, mixed), "utf8")).toBe(local.replaceAll("Card", "Panel") + members);
  });

  test("the migrated namespace rewrites qualified type members", async () => {
    const file = "components/qualified-owned.ts";
    const source = 'import type * as NS from "./ui/card";\nexport type X = NS.Card;\n';
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: { [file]: source } });
    const result = await runMigration(await loadProject(app), renameCard);
    expect(result.status).toBe("dry-run");
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.residuals).toEqual([]);
    expect(result.changes.find((c) => c.file === file)?.after).toBe(source.replace("NS.Card", "NS.Panel"));
  });

  test.each(["NS.Card", "NS.Sub.Card", "NS /* qualifier */ . Sub.Card"])("untraceable project qualifier %s holds only its file", async (reference) => {
    const file = "components/qualified-held.ts";
    const source = `import { Card } from "./ui/card";\nimport type * as NS from "./other";\nexport type X = ${reference};\nexport const card = Card;\n`;
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: {
      [file]: source,
      "components/other.ts": "export type Unrelated = string;\n",
    } });
    const project = await loadProject(app);
    const before = await snapshot(app);
    const result = await runMigration(project, renameCard);
    expect(result.status).toBe("dry-run");
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.changes.some((c) => c.file === file)).toBe(false);
    expect(result.changes.some((c) => c.file === "app/index.tsx")).toBe(true);
    expect(new Set(result.residuals.map((r) => r.file))).toEqual(new Set([file]));
    expect(result.residuals).toContainEqual(expect.objectContaining({ file, line: 3, reason: expect.stringContaining(`qualified reference ${reference} cannot be traced`) }));
    expect(await snapshot(app)).toEqual(before);
    const applied = await runMigration(project, renameCard, { write: true });
    expect(applied.status).toBe("applied");
    expect(await readFile(join(app, file), "utf8")).toBe(source);
  });

  test("a default export renamed to a named export keeps local uses bound, including mixed clauses", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: {
      "components/default.tsx": 'import Card from "./ui/card";\nexport const View = () => <Card/>;\n',
      "components/default-mixed.tsx": 'import Card, { CardHeader } from "./ui/card";\nexport const View = () => <Card><CardHeader/></Card>;\n',
    } });
    const project = await loadProject(app);
    const migration = spec([{ renameExport: { from: "default", to: "Panel" } }]);
    const result = await runMigration(project, migration, { write: true });
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.residuals).toEqual([]);
    expect(result.changes.find((c) => c.file === "components/default.tsx")?.after).toContain('import { Panel as Card } from "./ui/card";');
    expect(result.changes.find((c) => c.file === "components/default-mixed.tsx")?.after).toContain('import { Panel as Card } from "./ui/card";\nimport  { CardHeader } from "./ui/card";');
    expect((await runMigration(project, migration)).changes).toEqual([]);
  });

  test("opting in rewrites default import locals and named consumers through barrels", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: CASES });
    const result = await runMigration(await loadProject(app), renameCardAndBarrels);
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.changes.find((c) => c.file === "components/cards.ts")?.after).toBe('export { Panel } from "./ui/card";\nexport { Panel as default, CardTitle } from "./ui/card";\n');
    expect(result.changes.find((c) => c.file === "components/via-barrel.tsx")?.after).toBe('import Panel from "@/components/cards";\nimport { Panel as Named } from "@/components/cards";\n\nexport const Pair = () => <Panel><Named /></Panel>;\n');
  });

  test("replacement exports cover quoted, type-only, namespace and import-type forms and keep barrel names", async () => {
    const { app } = await setup({ exports: { CardTitle: "CardHeading" } }, { files: {
      "components/titles.ts": 'export { CardTitle } from "./ui/card";\n',
      "components/title-types.ts": 'import type { CardTitle } from "./ui/card";\nexport type T = typeof CardTitle;\n',
      "components/title-quotes.ts": 'import { "CardTitle" as Q } from "./ui/card";\nexport const title = Q;\n',
      "components/title-ns.ts": 'import * as ui from "./ui/card";\nexport const title = ui.CardTitle;\n',
      "components/title-import.ts": 'type T = typeof import("./ui/card").CardTitle;\n',
    } });
    const result = await runMigration(await loadProject(app), spec([{ removeExport: { name: "CardTitle", replacement: "CardHeading" } }]));
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    const after = new Map(result.changes.map((c) => [c.file, c.after]));
    expect(after.get("components/titles.ts")).toContain("CardHeading as CardTitle");
    expect(after.get("components/title-types.ts")).toContain("typeof CardHeading");
    expect(after.get("components/title-quotes.ts")).toContain('"CardHeading" as Q');
    expect(after.get("components/title-ns.ts")).toContain("ui.CardHeading");
    expect(after.get("components/title-import.ts")).toContain(").CardHeading");
  });

  test("export stars retain old public names and keep their consumers unchanged", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: {
      "components/stars.ts": 'export * from "./ui/card";\n',
      "components/star-use.tsx": 'import { Card } from "./stars";\nexport const View = () => <Card/>;\n',
    } });
    const project = await loadProject(app);
    const result = await runMigration(project, renameCard, { write: true });
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.changes.find((c) => c.file === "components/stars.ts")?.after).toContain('export { Panel as Card } from "./ui/card";');
    expect(result.changes.some((c) => c.file === "components/star-use.tsx")).toBe(false);
    expect((await runMigration(project, renameCard)).changes).toEqual([]);
  });

  test("type declarations resolve through type-only local barrels, and unrelated old words pass the independent gate", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: {
      "components/local-types.ts": 'import type { CardProps } from "./ui/card";\nexport type { CardProps };\n',
      "components/type-use.ts": 'import type { CardProps } from "./local-types";\nexport type T = CardProps;\n',
      "components/lookalikes.ts": 'import { Card } from "./legacy/card";\nconst words = "Card"; // Card stays here\nconst obj = { Card: 1 };\nfunction other(Card: number) { return Card; }\nexport { Card };\n',
      "components/legacy/card.ts": 'export const Card = 1;\n',
    } });
    const path = join(app, "components/ui/card.tsx");
    await writeFile(path, `${await readFile(path, "utf8")}\nexport interface PanelProps { title: string }\n`);
    const result = await runMigration(await loadProject(app), spec([{ renameExport: { from: "Card", to: "Panel" } }, { renameExport: { from: "CardProps", to: "PanelProps" } }]));
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.changes.find((c) => c.file === "components/local-types.ts")?.after).toContain("export type { PanelProps as CardProps }");
    expect(result.changes.some((c) => c.file === "components/type-use.ts")).toBe(false);
    expect(result.changes.some((c) => c.file === "components/lookalikes.ts")).toBe(false);
  });

  test("independent verification catches unreported namespace destructures and local re-exports", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: {
      "components/dynamic-ns.ts": 'import * as ui from "./ui/card";\nconst { Card } = ui;\n',
      "components/local-export.ts": 'import { Card } from "./ui/card";\nexport { Card };\n',
    } });
    const project = await loadProject(app);
    const before = await scanProject(project);
    const result = await verifyRewrite(project, renameCard, before, new Map([["components/local-export.ts", 'import { Panel } from "./ui/card";\nexport { Card };\n']]));
    expect(result.gates.find((g) => g.name === "old-api")?.ok).toBe(false);
    expect(result.gates.find((g) => g.name === "old-api")?.detail).toContain("components/dynamic-ns.ts:2");
    expect(result.gates.find((g) => g.name === "old-api")?.detail).toContain("components/local-export.ts:2");
  });

  test.each([false, true])("held barrels hold type-only importers transitively (renameBarrels=%s)", async (renameBarrels) => {
    const files = {
      "components/cards.ts": 'export { Card, CardTitle } from "./ui/card";\n',
      "components/bridge.ts": 'export type { Card } from "./cards";\n',
      "components/b2.tsx": 'import type { Card } from "@/components/bridge";\nexport type T = typeof Card;\n',
      "components/safe.tsx": 'import { Card } from "./ui/card";\nexport const Safe = () => <Card/>;\n',
    };
    const { app } = await setup({ exports: { Card: "Panel", CardTitle: null } }, { files });
    const result = await runMigration(await loadProject(app), spec([{ renameExport: { from: "Card", to: "Panel", renameBarrels } }, { removeExport: { name: "CardTitle" } }]), { write: true });
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.status).toBe("applied");
    for (const file of ["components/cards.ts", "components/bridge.ts", "components/b2.tsx"]) {
      expect(await readFile(join(app, file), "utf8")).toBe(files[file as keyof typeof files]);
      expect(result.residuals).toContainEqual(expect.objectContaining({ file, line: 1, reason: expect.stringMatching(/replacement|held/) }));
    }
    expect(result.gates.find((g) => g.name === "imports-resolve")?.ok).toBe(true);
  });

  test("a namespace destructure with no rewritable member is reported on its own", async () => {
    const file = "components/destructure.ts";
    const source = 'import * as ui from "@/components/ui";\nconst { Card } = ui;\n';
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: { [file]: source } });
    const result = await runMigration(await loadProject(app), renameCard);
    expect(result.residuals).toEqual([expect.objectContaining({ file, line: 2, reason: expect.stringContaining("namespace ui is used dynamically") })]);
    expect(result.changes.some((c) => c.file === file)).toBe(false);
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
  });

  test("quoted imports, namespace re-exports and static import types rewrite; dynamic imports are held", async () => {
    const files = {
      "components/quoted.tsx": 'import { "Card" as Q } from "./ui/card";\nexport const Quoted = () => <Q/>;\n',
      "components/ns-barrel.ts": 'export * as cardNs from "./ui/card";\n',
      "components/ns-use.tsx": 'import { cardNs } from "./ns-barrel";\nexport const View = () => <cardNs.Card/>;\nexport const C = cardNs.Card;\n',
      "components/ns-dynamic.ts": 'import { cardNs } from "./ns-barrel";\nconst { Card } = cardNs;\n',
      "components/import-types.ts": 'type A = typeof import("@/components/ui").Card;\ntype B = import("./ui/card").Card;\n',
      "components/import-dynamic.ts": 'import("@/components/ui").then(m => m.Card);\n',
    };
    const { app } = await setup({ exports: { Card: "Panel" } }, { files });
    const result = await runMigration(await loadProject(app), renameCard);
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    const after = new Map(result.changes.map((c) => [c.file, c.after]));
    expect(after.get("components/quoted.tsx")).toBe(files["components/quoted.tsx"].replace('"Card"', '"Panel"'));
    expect(after.get("components/ns-use.tsx")).toBe(files["components/ns-use.tsx"].replaceAll("cardNs.Card", "cardNs.Panel"));
    expect(after.get("components/import-types.ts")).toBe(files["components/import-types.ts"].replaceAll(").Card", ").Panel"));
    expect(after.has("components/import-dynamic.ts")).toBe(false);
    expect(after.has("components/ns-dynamic.ts")).toBe(false);
    expect(result.residuals).toContainEqual(expect.objectContaining({ file: "components/import-dynamic.ts", line: 1, reason: expect.stringContaining("dynamic import of @/components/ui") }));
    expect(result.residuals).toContainEqual(expect.objectContaining({ file: "components/ns-dynamic.ts", line: 2, reason: expect.stringContaining("used dynamically") }));
  });

  test("the independent old-api gate catches an unreported import type and a missed local use", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: { "components/old-type.ts": 'type Old = typeof import("./ui/card").Card;\n' } });
    const project = await loadProject(app);
    const before = await scanProject(project);
    const good = await runMigration(project, renameCard);
    const outputs = new Map(good.changes.map((c) => [c.file, c.after]));
    outputs.delete("components/old-type.ts");
    outputs.set("app/index.tsx", outputs.get("app/index.tsx")!.replace("<Panel key", "<Card key"));
    const { gates } = await verifyRewrite(project, renameCard, before, outputs);
    expect(gates.find((g) => g.name === "old-api")).toMatchObject({ ok: false, detail: expect.stringContaining("components/old-type.ts:1") });
    expect(gates.find((g) => g.name === "old-api")?.detail).toContain("app/index.tsx:16");
  });

  test("rewritten type-only imports must name exports available through the after-barrel", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: {
      "components/cards.ts": 'export { Panel as Card } from "./ui/card";\n',
      "components/types.ts": 'import type { Card } from "./cards";\nexport type T = typeof Card;\n',
    } });
    const project = await loadProject(app);
    const before = await scanProject(project);
    const result = await verifyRewrite(project, renameCard, before, new Map([["components/types.ts", 'import type { Panel } from "./cards";\nexport type T = typeof Panel;\n']]));
    expect(result.gates.find((g) => g.name === "imports-resolve")).toMatchObject({ ok: false, detail: expect.stringContaining("components/types.ts:1") });
  });

  test("owned barrels stay byte-identical", async () => {
    const source = 'export { Card } from "./card";\n';
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: { "components/ui/owned.ts": source } });
    const result = await runMigration(await loadProject(app), renameCard);
    expect(result.changes.some((c) => c.file === "components/ui/owned.ts")).toBe(false);
    expect(result.residuals.some((r) => r.file === "components/ui/owned.ts")).toBe(false);
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
  });

  test("shorthand is one reference before and after expanding its property key", async () => {
    const { app } = await setup({ exports: { Card: "Panel" } }, { files: { "components/registry.ts": 'import { Card } from "./ui/card";\nexport const registry = { Card };\n' } });
    const result = await runMigration(await loadProject(app), renameCard);
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    expect(result.gates.find((g) => g.name === "usage-count")?.detail).toBe("youi:demo/component/card: 11 before, 16 after, 16 expected (5 resolvable again under the new name)");
    expect(result.changes.find((c) => c.file === "components/registry.ts")?.after).toContain("{ Card: Panel }");
  });

  test.each([false, true])("barrel public names are kept unless opted in (renameBarrels=%s)", async (renameBarrels) => {
    const files = {
      "components/cards.ts": 'export { Card } from "./ui/card";\n',
      "components/local.ts": 'import { Card } from "./ui/card";\nexport { Card };\n',
      "components/local-alias.ts": 'import { Card as Box } from "./ui/card";\nexport { Box as Card };\n',
      "components/use.tsx": 'import { Card } from "./cards";\nexport const View = () => <Card/>;\n',
    };
    const { app } = await setup({ exports: { Card: "Panel" } }, { files });
    const result = await runMigration(await loadProject(app), renameBarrels ? renameCardAndBarrels : renameCard);
    expect(result.gates.filter((g) => !g.ok)).toEqual([]);
    const after = new Map(result.changes.map((c) => [c.file, c.after]));
    expect(after.get("components/cards.ts")).toBe(`export { ${renameBarrels ? "Panel" : "Panel as Card"} } from "./ui/card";\n`);
    expect(after.get("components/local.ts")).toContain(`export { ${renameBarrels ? "Panel" : "Panel as Card"} };`);
    expect(after.get("components/local-alias.ts")).toBe(`import { Panel as Box } from "./ui/card";\nexport { Box as ${renameBarrels ? "Panel" : "Card"} };\n`);
    expect(after.get("components/use.tsx")).toBe(renameBarrels ? files["components/use.tsx"].replaceAll("Card", "Panel") : undefined);
  });
});
