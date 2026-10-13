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
