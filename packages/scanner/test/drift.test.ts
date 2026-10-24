import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildInventory, nearDuplicates, hardcodedValues, loadProject, offLibraryImports, scanProject } from "../src/index.ts";

const DEMO = join(import.meta.dirname, "../../../examples/demo-app");

const CSS = `.promo {
  padding: 8px 12px;
  margin: 13px;
  border-radius: 8px;
  color: #c62828;
  gap: 12px;
}
.old {
  padding: 8px;
}
`;

async function moduleOf(file: string, source: string) {
  const scan = await scanProject(await loadProject(DEMO), { overrides: { [file]: source }, focus: [file] });
  return { module: scan.modules.get(file)!, tokens: scan.tokens };
}

describe("hardcoded values in stylesheets", () => {
  test("padding, gap and radius that a token holds name the token; other values and unchanged lines are left alone", async () => {
    const { module, tokens } = await moduleOf("components/promo.css", CSS);
    const added = (_file: string, line: number) => line <= 7;
    const found = hardcodedValues(module, tokens, { isTokenSource: false, added });
    expect(found.map((f) => [f.line, f.fix])).toEqual([
      [2, "use padding: var(--demo-space-sm) var(--demo-space-md) (space.sm, space.md)"],
      [4, "use border-radius: var(--demo-radius-control) (radius.control)"],
      [5, "use var(--demo-color-danger) (color.danger)"],
      [6, "use gap: var(--demo-space-md) (space.md)"],
    ]);
  });
});

describe("off-library imports", () => {
  test("only added imports, only for element types with a chosen library, never in exempt files", async () => {
    const source = `import { Button } from "@mui/material";\nimport { Tooltip } from "@mui/material";\nimport { Card } from "@mui/material";\n`;
    const { module } = await moduleOf("components/x.tsx", source);
    const chosen = new Map([["button", { library: "system", label: "the System's Button", fix: () => 'import { Button } from "@/components/ui"' }]]);
    const classify = (specifier: string, names: readonly string[]) => (specifier === "@mui/material" ? { library: "mui", label: "MUI", types: names.map((n) => n.toLowerCase()) } : null);
    const found = offLibraryImports(module, { added: (_f, line) => line !== 3, classify, chosen });
    expect(found.map((f) => [f.line, f.fix])).toEqual([[1, 'import { Button } from "@/components/ui"']]);
    expect(offLibraryImports(module, { added: () => true, classify, chosen, exempt: () => true })).toEqual([]);
  });
});


test("nearDuplicates ignores composition of an existing component but flags an implemented root", async () => {
  const root = await mkdtemp(join(tmpdir(), "youi-composition-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({name: "fixture", dependencies: {tailwindcss: "4.1.0"}}));
    await writeFile(join(root, "button.tsx"), 'export const Button = () => <button className="h-9 rounded-md px-4 text-sm">Buy</button>;\n');
    await writeFile(join(root, "promo.tsx"), 'import { Button } from "./button";\nexport const PromoCard = () => <Button />;\n');
    await writeFile(join(root, "quiet.tsx"), 'export const QuietButton = () => <button className="h-9 rounded-md px-4 text-sm">Buy</button>;\n');
    await writeFile(join(root, "badge.tsx"), 'export const Badge = () => <span className="rounded-md px-2 text-xs">New</span>;\n');
    await writeFile(join(root, "nested.tsx"), 'import { Badge } from "./badge";\nexport const QuietBadgeButton = () => <button className="h-9 rounded-md px-4 text-sm"><Badge/>Buy</button>;\n');
    await writeFile(join(root, "composed.tsx"), 'import { Button } from "./button";\nimport { memo, forwardRef } from "react";\nexport const NestedButton = () => <Button><button className="h-9 rounded-md px-4 text-sm">Buy</button></Button>;\nexport const MemoButton = memo(Button);\nexport const RefButton = forwardRef(Button);\nexport const AliasButton = Button;\nexport const ChainedButton = memo(AliasButton);\n');
    const inventory = await buildInventory([root], {cwd: root, definitionRoots: true});
    const findings = nearDuplicates({inventory, added: (file) => !["button.tsx", "badge.tsx"].includes(file), importOf: () => "./button"});
    const roots = new Map(inventory.definitions.map((d) => [d.name, d.root]));
    expect(roots.get("QuietBadgeButton")).toEqual({kind: "intrinsic", tag: "button"});
    for (const name of ["PromoCard", "NestedButton", "MemoButton", "RefButton", "AliasButton"]) {
      expect(roots.get(name)).toEqual({kind: "definition", id: inventory.definitions.find((d) => d.name === "Button")!.id});
    }
    expect(roots.get("ChainedButton")).toEqual({kind: "definition", id: inventory.definitions.find((d) => d.name === "AliasButton")!.id});
    expect((await buildInventory([root], {cwd: root})).definitions.every((d) => d.root === undefined)).toBe(true);
    expect(findings.map((f) => f.text)).toEqual(["QuietBadgeButton", "QuietButton"]);
  } finally { await rm(root, {recursive: true, force: true}); }
});

describe("nearDuplicates: a hand-styled element the change adds", () => {
  type Report = Parameters<typeof nearDuplicates>[0]["inventory"];
  const shape = (height: number | null, paddingX: number | null, radius: number | null, fontSize: number | null) => ({ height, paddingX, paddingY: null, radius, fontSize, fontWeight: null });
  const definition = (name: string, file: string, root: object) => ({ id: `p:${file}#${name}`, name, file, line: 1, kind: "react", root, variants: {} });
  const use = (name: string, file: string, at: string, line: number, s: ReturnType<typeof shape>) => ({ file: at, line, column: 5, role: "button", tag: name, source: "component", definition: `p:${file}#${name}`, shape: s, derived: [], recipe: { kind: "component", file, export: name, props: {}, label: null, wrappers: [], tag: "button", classes: [] } });
  const hand = (tag: string, line: number, s: ReturnType<typeof shape>) => ({ file: "app/new.tsx", line, column: 7, role: "button", tag, source: "intrinsic", definition: null, shape: s, derived: [], recipe: { kind: "class", tag, classes: [], label: null } });
  const BUTTON = shape(40, 16, 6, 14);
  const LINKISH = shape(48, 24, 8, 16);
  const TINY = shape(28, 8, 9999, 12);
  const SQUARE = shape(40, 0, 6, null);
  const inventory = {
    definitions: [
      definition("Button", "ui/button.tsx", { kind: "intrinsic", tag: "button" }),
      definition("LinkButton", "ui/link-button.tsx", { kind: "primitive", module: "next/link", name: "default" }),
      definition("TinyButton", "ui/tiny.tsx", { kind: "intrinsic", tag: "button" }),
      definition("IconButton", "ui/icon.tsx", { kind: "intrinsic", tag: "button" }),
    ],
    looks: [
      use("Button", "ui/button.tsx", "app/a.tsx", 3, BUTTON),
      use("LinkButton", "ui/link-button.tsx", "app/b.tsx", 3, LINKISH),
      // Used twice, but only in its own file: a helper, not the project's component.
      use("TinyButton", "ui/tiny.tsx", "ui/tiny.tsx", 6, TINY),
      use("TinyButton", "ui/tiny.tsx", "ui/tiny.tsx", 7, TINY),
      use("IconButton", "ui/icon.tsx", "app/c.tsx", 3, SQUARE),
      hand("button", 2, BUTTON),
      hand("button", 3, LINKISH),
      hand("a", 4, LINKISH),
      hand("button", 5, TINY),
      hand("button", 6, SQUARE),
    ],
  } as unknown as Report;
  const found = nearDuplicates({ inventory, added: (file) => file === "app/new.tsx", importOf: (file) => `@/${file.replace(/\.tsx$/, "")}` });

  test("a copy of a shared component is reported at the element, naming the component and its import", () => {
    expect(found.find((f) => f.line === 2)).toMatchObject({ kind: "near-duplicate", column: 7, text: "<button>", fix: 'use <Button> from "@/ui/button"' });
  });

  test("a link component is offered for a hand-styled link, never for a button", () => {
    expect(found.find((f) => f.line === 3)).toBeUndefined();
    expect(found.find((f) => f.line === 4)?.fix).toBe('use <LinkButton> from "@/ui/link-button"');
  });

  test("not a helper used only in its own file, and not a plain square: no side padding is too little to call a copy", () => {
    expect(found.map((f) => f.line)).toEqual([2, 4]);
  });
});
