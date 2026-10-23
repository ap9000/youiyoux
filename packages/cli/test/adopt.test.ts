/**
 * A System inside the product: its contracts, tokens and rules in the product's repo, its
 * implementations the product's own components, never copied.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

  test("a stylesheet or components folder outside the product is refused by name, from components.json, a flag or a symlink, and nothing is written", async () => {
    const outside = join(dir, "outside.css");
    await writeFile(outside, GLOBALS);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const shadcn = await shadcnApp("escape-json");
      const config = JSON.parse(await readFile(join(shadcn, "components.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(shadcn, "components.json"), JSON.stringify({ ...config, tailwind: { css: "../outside.css" } }));
      expect(await main(["adopt", "--project", shadcn])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain('the stylesheet "../outside.css" leads outside');

      const linked = await shadcnApp("escape-link");
      await rm(join(linked, "app/globals.css"));
      await symlink(outside, join(linked, "app/globals.css"));
      expect(await main(["adopt", "--project", linked])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain('the stylesheet "app/globals.css" leads outside');

      const flagged = await shadcnApp("escape-flag");
      expect(await main(["adopt", "--project", flagged, "--components", "../escape-link/components/ui"])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain('the components folder "../escape-link/components/ui" leads outside');
      for (const root of [shadcn, linked, flagged]) await expect(readFile(join(root, "youi.config.json"), "utf8")).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe(GLOBALS);
    } finally {
      err.mockRestore();
    }
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

const STYLES = `@import "tailwindcss";

:root {
  --acme-ink: #1c1c21;
  --acme-paper: #ffffff;
  --acme-accent: oklch(0.55 0.2 260);
  --acme-space-md: 12px;
  --acme-md: 16px;
  --acme-radius-card: 12px;
  --acme-typography-label-font-size: 13px;
  --acme-typography-label-line-height: 1.4;
  --acme-font-sans: "Geist", sans-serif;
  --legacy-gutter: 24px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --acme-ink: #ececf1;
    --acme-paper: #121214;
  }
}

:root[data-theme="dark"] {
  --acme-ink: #ececf1;
  --acme-paper: #121214;
}
`;

/** A product laid out as Toolroll is: components deep in src/browser, screen components beside them, prefixed variables, and a tokens.css youi generated before. */
async function nestedApp(name: string): Promise<string> {
  const root = join(dir, name);
  const component = (n: string): string => `export function ${n}({ className }: { className?: string }) {\n  return <div className={className} />;\n}\n`;
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "acme-console", dependencies: { react: "19.2.0", "react-dom": "19.2.0" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    "src/browser/components/ui/button.tsx": component("Button"),
    "src/browser/components/ui/card.tsx": component("Card"),
    "src/browser/components/ui/index.ts": 'export { Button } from "./button";\nexport { Card } from "./card";\n',
    "src/browser/ui/activity-row.tsx": component("ActivityRow"),
    "src/browser/ui/conversation.tsx": component("Conversation"),
    "src/browser/ui/plan.tsx": component("Plan"),
    "src/browser/app.tsx": 'import { Button, Card } from "@/browser/components/ui";\n\nexport function App() {\n  return <Card><Button /></Card>;\n}\n',
    "src/design/tokens.css": `/* @generated by youi from the Signal design language v1.0.0. Do not edit. */\n:root {\n${Array.from({ length: 30 }, (_, i) => `  --so-c${i}: #000000;`).join("\n")}\n}\n`,
    "src/styles/app.css": STYLES,
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

describe("youiyoux adopt on a product laid out as Toolroll is", () => {
  test("it finds components/ui at any depth, never reads a stylesheet youi generated, names tokens without their shared prefix and keeps a type style's parts as typography", async () => {
    const root = await nestedApp("nested-app");
    out = "";
    expect(await main(["adopt", "--project", root])).toBe(0);
    expect(out).toContain("2 components in src/browser/components/ui (Button, Card)");
    // Its generated tokens.css is Signal's: left to it, and adopt says how to keep one System, or fork it.
    expect(out).toContain("src/design/tokens.css holds 30 variables youiyoux generated from Signal v1.0.0: this product already uses that System, so they were left to it. To manage the product with Signal, run youiyoux init --design <Signal's repo or package>; to make a System of the product's own from them, run youiyoux adopt --fork");
    expect(out).toContain("from src/styles/app.css");
    expect(out).toContain("1 variable without the --acme- prefix stay in src/styles/app.css: --legacy-gutter");
    const tokens = JSON.parse(await readFile(join(root, "design/tokens/acme-console.tokens.json"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(Object.keys(tokens.color!).sort()).toEqual(["accent", "ink", "paper"]);
    // space-md would be space.md, but --acme-md is space.md: each keeps a path of its own, so neither value is lost.
    expect(Object.keys(tokens.space!).sort()).toEqual(["md", "space-md"]);
    expect(Object.keys(tokens.radius!)).toEqual(["card"]);
    // A line height of 1.4 is the number 1.4, never 1.4px.
    expect(tokens.typography).toEqual({ "label-font-size": expect.objectContaining({ $type: "dimension", $value: { value: 13, unit: "px" } }), "label-line-height": expect.objectContaining({ $type: "number", $value: 1.4 }) });
    const project = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as { outputs: Record<string, unknown>; importFrom: string };
    // Dark is written for the OS setting and for the toggle: both move, and both are generated.
    expect(project.outputs).toMatchObject({ cssVarPrefix: "acme", dark: [{ selector: ':root[data-theme="dark"]' }, { media: "(prefers-color-scheme: dark)", selector: ':root:not([data-theme="light"])' }] });
    expect(project.importFrom).toBe("@/browser/components/ui");
    expect(await readFile(join(root, "src/design/tokens.css"), "utf8")).toContain("--so-c0");
    const built = await readFile(join(root, "design/build/tokens.css"), "utf8");
    const blocks = { light: { selector: ":root" }, dark: { selector: ':root[data-theme="dark"]' } };
    const parity = compareParity(STYLES, blocks, built, blocks, "acme");
    expect(parity.different).toEqual([]);
    expect(parity.missing.map((m) => m.variable)).toEqual(["--acme-font-sans"]);
    expect(built).toContain("--acme-typography-label-line-height: 1.4;");
    const styles = await readFile(join(root, "src/styles/app.css"), "utf8");
    expect(styles).toContain('@import "tailwindcss";\n@import "../../design/build/tokens.css";');
    expect(styles).toContain("--legacy-gutter: 24px;");
    expect(styles).not.toContain("--acme-ink");
    expect(styles).not.toContain("@media");
    expect(styles).not.toContain("data-theme");
    const media = { light: { selector: ":root" }, dark: { selector: ':root:not([data-theme="light"])', outer: "@media (prefers-color-scheme: dark)" } };
    expect(compareParity(STYLES, media, built, media, "acme").different).toEqual([]);
    expect(await readFile(join(root, "DESIGN.md"), "utf8")).toContain("ink:");
  }, 60_000);

  test("a generated stylesheet named by components.json is passed over, and one named by --css is refused", async () => {
    const root = await nestedApp("generated-app");
    await writeFile(join(root, "components.json"), JSON.stringify({ tailwind: { css: "src/design/tokens.css" } }));
    out = "";
    expect(await main(["adopt", "--project", root, "--dry-run"])).toBe(0);
    expect(out).toContain("from src/styles/app.css");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["adopt", "--project", root, "--css", "src/design/tokens.css"])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain("src/design/tokens.css is generated by youiyoux sync from Signal: name the stylesheet the product writes its own variables in, or take that System's values as the product's own with youiyoux adopt --fork");
    } finally {
      err.mockRestore();
    }
  }, 60_000);

  test("--fork takes the variables a System generated as the start of the product's own: all of them move, and the file is the product's own from then on", async () => {
    const root = await nestedApp("fork-app");
    const generated = await readFile(join(root, "src/design/tokens.css"), "utf8");
    out = "";
    expect(await main(["adopt", "--project", root, "--fork"])).toBe(0);
    expect(out).toContain("30 variables from src/design/tokens.css → design/tokens");
    expect(out).toContain("forked from Signal v1.0.0: this product's System starts from the 30 variables it generated into src/design/tokens.css, and the product no longer follows Signal");
    expect(out).not.toContain("so they were left to it");
    const tokens = JSON.parse(await readFile(join(root, "design/tokens/acme-console.tokens.json"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(Object.keys(tokens.color!)).toHaveLength(30);
    expect(Object.keys(tokens.color!)[0]).toBe("c0");
    const kept = await readFile(join(root, "src/design/tokens.css"), "utf8");
    expect(kept).not.toContain("@generated");
    expect(kept).toContain('@import "../../design/build/tokens.css";');
    const built = await readFile(join(root, "design/build/tokens.css"), "utf8");
    const parity = compareParity(generated, { light: { selector: ":root" } }, built, { light: { selector: ":root" } }, "so");
    expect([parity.matched, parity.different, parity.missing]).toEqual([30, [], []]);
  }, 60_000);

  test("when the new System cannot be synced, adopt is undone: its files removed, the stylesheet as it was", async () => {
    const root = await nestedApp("undone-app");
    vi.resetModules();
    vi.doMock("../src/sync.ts", async (original) => ({ ...(await original<typeof import("../src/sync.ts")>()), syncProject: async () => Promise.reject(new Error("the tokens do not build")) }));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const fresh = (await import("../src/index.ts")).main;
      expect(await fresh(["adopt", "--project", root])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain("adopt was undone, nothing kept: the tokens do not build");
    } finally {
      err.mockRestore();
      vi.doUnmock("../src/sync.ts");
      vi.resetModules();
    }
    expect(await readFile(join(root, "src/styles/app.css"), "utf8")).toBe(STYLES);
    for (const gone of ["youi.config.json", "youi.project.json", "design"]) await expect(readdir(join(root, gone))).rejects.toThrow(/ENOENT/);
  }, 60_000);
});

describe("youiyoux system extract", () => {
  test("an adopted System moves into its own design repo; the product follows it by path, unchanged, and a change made there merges into it", async () => {
    const root = await shadcnApp("extract-app");
    expect(await main(["adopt", "--project", root])).toBe(0);
    const [button, tokensCss] = await Promise.all([readFile(join(root, "components/ui/button.tsx"), "utf8"), readFile(join(root, "design/build/tokens.css"), "utf8")]);
    const target = join(dir, "acme-design");
    out = "";
    expect(await main(["system", "extract", target, "--project", root, "--package", "@acme/design"])).toBe(0);
    expect(out).toContain(`extracted @acme/web (system web) → ${target}`);
    expect(out).toContain("2 contracts with their implementations beside them");

    // A plain design repo: implementations beside their contracts, no implementations folder.
    const config = JSON.parse(await readFile(join(target, "youi.config.json"), "utf8")) as { systems: Record<string, unknown>[] };
    expect(config.systems[0]).toMatchObject({ id: "web", tokens: "tokens/web.resolver.json", components: "components", rules: "rules", design: "design.md" });
    expect(config.systems[0]).not.toHaveProperty("implementations");
    expect(await readFile(join(target, "components/button/button.tsx"), "utf8")).toBe(button);
    expect(JSON.parse(await readFile(join(target, "components/card/card.contract.json"), "utf8"))).toMatchObject({ source: { file: "card/card.tsx", also: ["CardHeader"] } });
    expect(JSON.parse(await readFile(join(target, "package.json"), "utf8"))).toMatchObject({ name: "@acme/design", version: "0.1.0" });

    // The product: its System files gone, its components and generated tokens as they were, now vendored copies.
    for (const gone of ["youi.config.json", "design/components", "design/tokens", "design/rules", "design/design.md"]) await expect(readFile(join(root, gone), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(root, "youi.project.json"), "utf8"))).toMatchObject({ source: { path: "../acme-design" } });
    expect(await readFile(join(root, "components/ui/button.tsx"), "utf8")).toBe(button);
    expect(await readFile(join(root, "design/build/tokens.css"), "utf8")).toBe(tokensCss);
    const lock = JSON.parse(await readFile(join(root, "youi.lock.json"), "utf8")) as { files: Record<string, { kind: string }> };
    expect(lock.files["components/ui/button.tsx"]).toMatchObject({ kind: "vendored" });
    expect(await verifyLock(await loadProject(root))).toEqual([]);

    // The System changes in its own repo now, and sync brings it to the product.
    await writeFile(join(target, "components/button/button.tsx"), button.replace("rounded-md", "rounded-lg"));
    expect(await main(["sync", "--project", root])).toBe(0);
    expect(await readFile(join(root, "components/ui/button.tsx"), "utf8")).toContain("rounded-lg");
  }, 60_000);

  test("it refuses a System that is already its own repo and a folder that is not empty, and a dry run changes nothing", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const plain = join(dir, "plain-app");
      await cp(join(EXAMPLES, "demo-app"), plain, { recursive: true });
      const config = JSON.parse(await readFile(join(plain, "youi.project.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(plain, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { path: join(EXAMPLES, "demo-design") } }));
      expect(await main(["system", "extract", join(dir, "nowhere"), "--project", plain])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain("is already a design repo of its own");

      const root = await shadcnApp("extract-refused");
      expect(await main(["adopt", "--project", root])).toBe(0);
      const full = join(dir, "full");
      await mkdir(full, { recursive: true });
      await writeFile(join(full, "README.md"), "mine\n");
      expect(await main(["system", "extract", full, "--project", root])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain("already exists and is not empty");
      // A System folder that is the product's root, or holds what stays, would copy the product (secrets too) and remove it.
      const adopted = await readFile(join(root, "youi.config.json"), "utf8");
      await writeFile(join(root, ".env"), "TOKEN=not-for-the-design-repo\n");
      for (const [field, value, said] of [["tokens", "web.resolver.json", "is not a folder of its own"], ["tokens", "components/web.resolver.json", "holds components/ui, which stays in the product"]] as const) {
        const system = (JSON.parse(adopted) as { systems: Record<string, unknown>[] }).systems[0]!;
        await writeFile(join(root, "youi.config.json"), JSON.stringify({ schema: "youi.config/v1", name: "x", systems: [{ ...system, [field]: value }] }));
        err.mockClear();
        expect(await main(["system", "extract", join(dir, "root-design"), "--project", root])).toBe(1);
        expect(err.mock.calls.flat().join("")).toContain(said);
        await expect(readdir(join(dir, "root-design"))).rejects.toThrow();
      }
      await writeFile(join(root, "youi.config.json"), adopted);
      const productConfig = await readFile(join(root, "youi.project.json"), "utf8");
      const followed = JSON.parse(productConfig) as { outputs: Record<string, unknown> };
      await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...followed, outputs: { ...followed.outputs, dir: "design/tokens/out" } }));
      err.mockClear();
      expect(await main(["system", "extract", join(dir, "root-design"), "--project", root])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain("holds design/tokens/out, which stays in the product");
      await writeFile(join(root, "youi.project.json"), productConfig);
      expect(await readFile(join(root, ".env"), "utf8")).toContain("TOKEN");
      expect(await readFile(join(root, "components/ui/button.tsx"), "utf8")).toContain("buttonVariants");
      // A link in the System that leads outside it would carry what it points at into the new repo.
      await writeFile(join(dir, "secret.json"), "{}\n");
      await symlink(join(dir, "secret.json"), join(root, "design/tokens/leak.json"));
      expect(await main(["system", "extract", join(dir, "leaky-design"), "--project", root])).toBe(1);
      expect(err.mock.calls.flat().join("")).toContain("links that lead outside it (tokens/leak.json)");
      await expect(readdir(join(dir, "leaky-design"))).rejects.toThrow();
      await rm(join(root, "design/tokens/leak.json"));
      out = "";
      expect(await main(["system", "extract", join(dir, "dry-design"), "--project", root, "--dry-run"])).toBe(0);
      expect(out).toContain("dry run: nothing written or removed");
      await expect(readdir(join(dir, "dry-design"))).rejects.toThrow();
      expect(await readFile(join(root, "youi.config.json"), "utf8")).toContain('"implementations": "components/ui"');
      expect((await readdir(dir)).filter((name) => name.startsWith("."))).toEqual([]);
    } finally {
      err.mockRestore();
    }
  }, 60_000);
});
