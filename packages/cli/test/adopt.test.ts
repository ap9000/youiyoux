/**
 * A System inside the product: its contracts, tokens and rules in the product's repo, its
 * implementations the product's own components, never copied.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { compareParity } from "@youiyoux/tokens";
import { main } from "../src/index.ts";
import { syncProject, verifyLock } from "../src/sync.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");

let dir: string;
let out = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-adopt-")));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The demo app holding the demo system itself: contracts under design/, implementations in components/ui. */
async function inPlace(name: string): Promise<string> {
  const root = join(dir, name);
  await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
  const design = join(EXAMPLES, "demo-design");
  await cp(join(design, "tokens"), join(root, "design/tokens"), { recursive: true });
  await cp(join(design, "rules"), join(root, "design/rules"), { recursive: true });
  for (const folder of (await readdir(join(design, "components"))).filter((f) => !f.startsWith("_"))) {
    const contract = JSON.parse(await readFile(join(design, "components", folder, `${folder}.contract.json`), "utf8")) as { source: { file: string } };
    await mkdir(join(root, "design/components", folder), { recursive: true });
    await writeFile(join(root, "design/components", folder, `${folder}.contract.json`), JSON.stringify({ ...contract, $schema: undefined, source: { ...contract.source, file: contract.source.file.split("/").at(-1) } }));
  }
  const config = JSON.parse(await readFile(join(design, "youi.config.json"), "utf8")) as { systems: Record<string, unknown>[] };
  const system = { ...config.systems[0], tokens: "design/tokens/demo/demo.resolver.json", components: "design/components", implementations: "components/ui", support: ["utils.ts"], rules: "design/rules", design: undefined };
  await writeFile(join(root, "youi.config.json"), JSON.stringify({ schema: "youi.config/v1", name: name, systems: [system] }));
  const project = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...project, $schema: undefined, source: { path: "." } }));
  return root;
}

describe("a System inside the product", () => {
  test("sync copies none of its implementations and locks none: editing a component is changing the System, never drift", async () => {
    const root = await inPlace("in-place-app");
    const before = await readFile(join(root, "components/ui/button.tsx"), "utf8");
    const project = await loadProject(root);
    expect(project.repo.root).toBe(root);
    expect(project.system.components.map((c) => c.contract.name).sort()).toEqual(["Button", "Card", "Input"]);
    const { actions, lock } = await syncProject(project);
    expect(actions.filter((a) => a.role === "component").map((a) => [a.file, a.detail])).toEqual(
      ["button.tsx", "card.tsx", "input.tsx", "utils.ts"].map((f) => [`components/ui/${f}`, "the system's own implementation, in this project"]),
    );
    expect(Object.keys(lock.files).filter((f) => f.startsWith("components/"))).toEqual([]);
    expect(await readFile(join(root, "components/ui/button.tsx"), "utf8")).toBe(before);
    // Tokens and the agent files are still generated from the System.
    expect(await readFile(join(root, "src/design/tokens.css"), "utf8")).toContain("--demo-color-accent");
    await writeFile(join(root, "components/ui/button.tsx"), `${before}\n// a change to the System's Button\n`);
    expect(await verifyLock(await loadProject(root))).toEqual([]);
  });
});

const GLOBALS = `@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-primary: var(--primary);
  --radius-lg: var(--radius);
}

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --ring: var(--primary);
  --sidebar-width: calc(16rem + 2px);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
}

@layer base {
  body {
    @apply bg-background text-foreground;
  }
}
`;

/** A shadcn/ui app as `npx shadcn init` leaves it on Tailwind v4: oklch variables, a .dark block, CVA components. */
async function shadcnApp(name: string): Promise<string> {
  const root = join(dir, name);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "@acme/web", dependencies: { next: "16.0.0", react: "19.2.0", "react-dom": "19.2.0", "class-variance-authority": "0.7.1" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["./*"] } } }),
    "components.json": JSON.stringify({ $schema: "https://ui.shadcn.com/schema.json", style: "new-york", tailwind: { css: "app/globals.css" }, aliases: { components: "@/components", ui: "@/components/ui", utils: "@/lib/utils" } }),
    "lib/utils.ts": "export function cn(...inputs: string[]) {\n  return inputs.filter(Boolean).join(\" \");\n}\n",
    "components/ui/button.tsx": [
      'import { cva, type VariantProps } from "class-variance-authority";',
      'import { cn } from "@/lib/utils";',
      "",
      "const buttonVariants = cva(\"inline-flex h-9 items-center rounded-md px-4 text-sm font-medium\", {",
      "  variants: {",
      '    variant: { default: "bg-primary text-primary-foreground", destructive: "bg-destructive text-white", outline: "border bg-background" },',
      '    size: { default: "h-9 px-4", sm: "h-8 px-3" },',
      "  },",
      '  defaultVariants: { variant: "default", size: "default" },',
      "});",
      "",
      'function Button({ className, variant, size, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {',
      "  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;",
      "}",
      "",
      "export { Button, buttonVariants };",
      "",
    ].join("\n"),
    "components/ui/card.tsx": [
      'import { cn } from "@/lib/utils";',
      "",
      'export function Card({ className, ...props }: React.ComponentProps<"div">) {',
      '  return <div className={cn("rounded-xl border bg-background p-6", className)} {...props} />;',
      "}",
      "",
      'export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {',
      '  return <div className={cn("grid gap-1.5", className)} {...props} />;',
      "}",
      "",
    ].join("\n"),
    "app/globals.css": GLOBALS,
    "components/legacy-button.tsx": 'export function Button(props: React.ComponentProps<"button">) {\n  return <button {...props} />;\n}\n',
    "app/old/page.tsx": 'import { Button } from "@/components/legacy-button";\n\nexport default function Old() {\n  return <p style={{ color: "#171717" }}><Button>Old</Button></p>;\n}\n',
    "app/page.tsx": [
      'import { Button } from "@/components/ui/button";',
      'import { Card, CardHeader } from "@/components/ui/card";',
      "",
      "export default function Page() {",
      "  return (",
      "    <Card>",
      '      <CardHeader style={{ color: "#ff0000" }}>Invite</CardHeader>',
      '      <Button variant="outline">Save</Button>',
      "      <Button>Send</Button>",
      "    </Card>",
      "  );",
      "}",
      "",
    ].join("\n"),
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

describe("youiyoux adopt", () => {
  test("a shadcn/ui app becomes its own System: a draft contract per component, its oklch variables as tokens under their own names, moved out of the stylesheet", async () => {
    const root = await shadcnApp("shadcn-app");
    out = "";
    expect(await main(["adopt", "--project", root])).toBe(0);
    expect(out).toContain("adopted @acme/web");
    expect(out).toContain("2 components in components/ui (Button, Card)");
    expect(out).toContain("6 variables, light and dark, from app/globals.css → design/tokens");
    expect(out).toContain("--sidebar-width (calc(16rem + 2px))");

    const system = (JSON.parse(await readFile(join(root, "youi.config.json"), "utf8")) as { systems: Record<string, unknown>[] }).systems[0]!;
    expect(system).toMatchObject({ id: "web", implementations: "components/ui", components: "design/components", support: [], themeModifier: { dark: "dark" } });
    const button = JSON.parse(await readFile(join(root, "design/components/button/button.contract.json"), "utf8")) as Record<string, unknown>;
    expect(button).toMatchObject({ id: "youi:web/component/button", name: "Button", status: "draft", source: { file: "button.tsx", export: "Button", also: [] }, aliases: ["buttonVariants"], props: { variant: { type: "enum", values: ["default", "destructive", "outline"], default: "default" }, size: { type: "enum", values: ["default", "sm"] }, className: { type: "string" } } });
    expect(button.summary).toBe("The product's own Button (components/ui/button.tsx), used at 2 sites.");
    const card = JSON.parse(await readFile(join(root, "design/components/card/card.contract.json"), "utf8")) as Record<string, unknown>;
    expect(card).toMatchObject({ name: "Card", source: { file: "card.tsx", export: "Card", also: ["CardHeader"] } });

    // The stylesheet keeps everything but the moved variables, and imports them back under the same names.
    const globals = await readFile(join(root, "app/globals.css"), "utf8");
    expect(globals).toContain('@import "tw-animate-css";\n@import "../design/build/tokens.css";');
    expect(globals).not.toContain("--primary: oklch");
    expect(globals).not.toContain(".dark {");
    expect(globals).toContain(":root {\n  --sidebar-width: calc(16rem + 2px);\n}");
    expect(globals).toContain("@theme inline {\n  --color-background: var(--background);");
    const built = await readFile(join(root, "design/build/tokens.css"), "utf8");
    expect(built).toContain("--primary: oklch(0.205 0 0);");
    expect(built).toContain("--ring: var(--primary);");
    expect(built).toContain(".dark {");
    // What the browser reads is unchanged: every moved variable has the value it had, light and dark.
    const parity = compareParity(GLOBALS, { light: { selector: ":root" }, dark: { selector: ".dark" } }, built, { light: { selector: ":root" }, dark: { selector: ".dark" } }, "");
    expect(parity.different).toEqual([]);
    expect(parity.missing).toEqual([{ mode: "light", variable: "--sidebar-width" }]);

    const project = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
    expect(project).toMatchObject({ system: "web", source: { path: "." }, componentsDir: "components/ui", importFrom: "@/components/ui/{file}", tokenSources: ["app/globals.css"], outputs: { dir: "design/build", cssVarPrefix: "", dark: [{ selector: ".dark" }], targets: ["css-vars"] } });
    expect(await readFile(join(root, "components/ui/button.tsx"), "utf8")).toContain("buttonVariants");
    // shadcn/ui has no barrel: each component is imported from its own file, and agents are told so.
    const designMd = await readFile(join(root, "DESIGN.md"), "utf8");
    expect(designMd).toContain('`import { Button } from "@/components/ui/button";`');
    expect(designMd).toContain('`import { Card, CardHeader } from "@/components/ui/card";`');

    // The checks now speak the product's own names, as warnings to begin with.
    out = "";
    expect(await main(["check", "--project", root])).toBe(0);
    expect(out).toContain("no-raw-color");
    // #171717 is --primary's light value (oklch(0.205 0 0)); a lookalike Button is pointed at the System's own file.
    expect(out).toContain("var(--primary)");
    expect(out).toContain('import { Button } from "@/components/ui/button"');
    out = "";
    expect(await main(["show", "Button", "--project", root])).toBe(0);
    expect(out).toContain("destructive");
  }, 60_000);

  test("it writes nothing when the product already follows a system, a file it would write is there, or with --dry-run", async () => {
    const root = await shadcnApp("dry-app");
    out = "";
    expect(await main(["adopt", "--project", root, "--dry-run"])).toBe(0);
    expect(out).toContain("dry run: nothing written");
    expect(await readFile(join(root, "app/globals.css"), "utf8")).toBe(GLOBALS);
    await expect(readFile(join(root, "youi.config.json"), "utf8")).rejects.toThrow();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await mkdir(join(root, "design/rules"), { recursive: true });
      await writeFile(join(root, "design/rules/color.no-raw-color.rule.yaml"), "mine\n");
      expect(await main(["adopt", "--project", root])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain("nothing was written: design/rules/color.no-raw-color.rule.yaml already exists");
      expect(await readFile(join(root, "app/globals.css"), "utf8")).toBe(GLOBALS);
      await rm(join(root, "design"), { recursive: true });
      expect(await main(["adopt", "--project", root])).toBe(0);
      err.mockClear();
      expect(await main(["adopt", "--project", root])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain("already has youi.project.json");
    } finally {
      err.mockRestore();
    }
  }, 60_000);
});
