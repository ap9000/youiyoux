/** A Discover preview's bundle: what it draws from an item's exports, and the fence widened by exactly the preview directory. */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { bundlePreview, composeOf } from "../src/index.ts";

const CONSOLE = join(import.meta.dirname, "fixtures/inventory/console");
const scratch = mkdtempSync(join(tmpdir(), "youi-preview-bundle-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function previewDir(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

test("a compound is drawn with the parts its kind needs; a plain component with its label", () => {
  expect(composeOf("command", ["Command", "CommandInput", "CommandList", "CommandGroup", "CommandItem"], "Command")).toMatchObject({ export: "Command", children: [{ export: "CommandInput" }, { export: "CommandList", children: [{ export: "CommandGroup", children: [{ export: "CommandItem" }, { export: "CommandItem" }, { export: "CommandItem" }] }] }] });
  expect(composeOf("tabs", ["Tabs", "TabsList", "TabsTrigger", "TabsContent"], "Tabs")).toMatchObject({ props: { defaultValue: "account" }, children: [{ export: "TabsList" }, { export: "TabsContent" }, { export: "TabsContent" }] });
  expect(composeOf("dialog", ["Dialog", "DialogTrigger", "DialogContent", "DialogTitle"], "Dialog")).toMatchObject({ props: { open: true } });
  expect(composeOf("button", ["Button", "buttonVariants"], "Button")).toEqual({ export: "Button", props: {}, children: ["Button"] });
  expect(composeOf("input", ["Input"], "Email")).toEqual({ export: "Input", props: { placeholder: "Email" }, children: [] });
  expect(composeOf("x", ["helper"], "X")).toBeNull();
  // Parts that must sit inside another: an accordion's triggers in its items, a menubar's in its menus.
  expect(composeOf("accordion", ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"], "Accordion")).toMatchObject({ export: "Accordion", props: { type: "single", defaultValue: "item-1" }, children: [{ export: "AccordionItem", props: { value: "item-1" }, children: [{ export: "AccordionTrigger" }, { export: "AccordionContent" }] }, { export: "AccordionItem" }] });
  expect(composeOf("menubar", ["Menubar", "MenubarMenu", "MenubarTrigger", "MenubarContent", "MenubarItem"], "Menubar")).toMatchObject({ export: "Menubar", children: [{ export: "MenubarMenu", children: [{ export: "MenubarTrigger", children: ["File"] }, { export: "MenubarContent" }] }, { export: "MenubarMenu" }, { export: "MenubarMenu" }] });
  // A dialog has a trigger and content but no items: still drawn open.
  expect(composeOf("alert-dialog", ["AlertDialog", "AlertDialogTrigger", "AlertDialogContent", "AlertDialogTitle"], "Alert Dialog")).toMatchObject({ props: { open: true } });
});

test("the item bundles with the project's cn and React; an import that leaves the project, its packages and the preview is refused", async () => {
  const ok = previewDir("ok", { "ui/badge.tsx": 'import { cn } from "cn";\nexport function Badge(props: { children?: unknown }) { return <span className={cn("rounded-md text-xs")}>{props.children as never}</span>; }\n' });
  const built = await bundlePreview({ root: CONSOLE, tsconfig: "tsconfig.json", dir: ok, main: "ui/badge.tsx", compose: { export: "Badge", props: {}, children: ["New"] }, fallback: null });
  expect("hash" in built && built.notes).toEqual(["cn: your src/lib/utils.ts"]);
  const outside = join(scratch, "outside.ts");
  writeFileSync(outside, "export const secret = 1;\n");
  const evil = previewDir("evil", { "ui/x.tsx": `import { secret } from ${JSON.stringify(outside)};\nexport function X() { return <b>{secret}</b>; }\n` });
  const refused = await bundlePreview({ root: CONSOLE, tsconfig: "tsconfig.json", dir: evil, main: "ui/x.tsx", compose: { export: "X", props: {}, children: [] }, fallback: null });
  expect(refused).toEqual({ error: expect.stringMatching(/resolves outside the preview, your project.s aliased source, the project components it was given and the installed packages/) });
  const missing = previewDir("missing", { "ui/y.tsx": 'import { motion } from "motion/react";\nexport function Y() { return <motion.div />; }\n' });
  expect(await bundlePreview({ root: CONSOLE, tsconfig: "tsconfig.json", dir: missing, main: "ui/y.tsx", compose: { export: "Y", props: {}, children: [] }, fallback: null })).toEqual({ error: "it needs motion, which is installed in neither your project nor the hub" });
}, 60_000);

test("radix-ui parts come from the @radix-ui packages there are; a part nobody has is a reason, not a crash when it runs", async () => {
  // The console has @radix-ui/react-tabs but not react-accordion, and no radix-ui meta-package.
  const tabs = previewDir("radix-tabs", { "ui/tabs.tsx": 'import { Tabs as TabsPrimitive } from "radix-ui";\nexport function Tabs() { return <TabsPrimitive.Root />; }\n' });
  const built = await bundlePreview({ root: CONSOLE, tsconfig: "tsconfig.json", dir: tabs, main: "ui/tabs.tsx", compose: { export: "Tabs", props: {}, children: [] }, fallback: null });
  expect("hash" in built && built.notes).toContain("radix-ui is not installed: its Tabs comes from @radix-ui/react-tabs");
  const accordion = previewDir("radix-accordion", { "ui/accordion.tsx": 'import { Accordion as AccordionPrimitive } from "radix-ui";\nexport function Accordion() { return <AccordionPrimitive.Root type="single" />; }\n' });
  expect(await bundlePreview({ root: CONSOLE, tsconfig: "tsconfig.json", dir: accordion, main: "ui/accordion.tsx", compose: { export: "Accordion", props: {}, children: [] }, fallback: null })).toEqual({ error: "it needs radix-ui's Accordion (@radix-ui/react-accordion), installed in neither your project nor the hub" });
}, 60_000);

describe("what a fetched file may read", () => {
  // A project with secrets beside its code, and another folder's packages cache.
  const project = join(scratch, "project");
  const write = (path: string, text: string): string => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  write(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["./src/*"] } } }));
  write(join(project, ".env"), "API_KEY=ENV_SECRET\n");
  write(join(project, "creds.json"), '{ "token": "JSON_SECRET" }\n');
  write(join(project, "notes.txt"), "TXT_SECRET\n");
  write(join(project, "secret.ts"), 'export const key = "ROOT_CODE_SECRET";\n');
  write(join(project, "src/components/ui/button.tsx"), "export function Button(props: { children?: unknown }) { return <button>{props.children as never}</button>; }\n");
  symlinkSync(join(import.meta.dirname, "../node_modules"), join(project, "node_modules"));
  const otherCache = write(join(scratch, "other/node_modules/.cache/x.json"), '{ "cached": "CACHE_SECRET" }\n');
  const otherCode = write(join(scratch, "other/node_modules/.cache/x.js"), 'export default "CACHE_CODE_SECRET";\n');

  const run = async (name: string, source: string) => {
    const dir = previewDir(`read-${name}`, { "ui/x.tsx": source });
    return bundlePreview({ root: project, tsconfig: "tsconfig.json", dir, main: "ui/x.tsx", compose: { export: "X", props: {}, children: [] }, fallback: null });
  };
  const refused = (built: Awaited<ReturnType<typeof bundlePreview>>, reason: RegExp): void => {
    expect("code" in built && /SECRET/.test(built.code)).toBe(false);
    expect(built).toEqual({ error: expect.stringMatching(reason) });
  };

  test("an aliased climb to .env, imported as text, is refused", async () => {
    refused(await run("env-text", 'import env from "@/../.env" with { type: "text" };\nexport const X = () => <i>{env}</i>;\n'), /may not import with attributes \(type: text\)/);
    refused(await run("env", 'import env from "@/../.env";\nexport const X = () => <i>{String(env)}</i>;\n'), /may import code only .* not \.env/);
  }, 60_000);

  test("a relative climb to a project JSON file is refused", async () => {
    refused(await run("json", `import creds from ${JSON.stringify(join(project, "creds.json"))};\nexport const X = () => <i>{JSON.stringify(creds)}</i>;\n`), /not creds\.json/);
    refused(await run("json-rel", 'import creds from "../../project/creds.json";\nexport const X = () => <i>{JSON.stringify(creds)}</i>;\n'), /not creds\.json/);
  }, 60_000);

  test("a text file is refused", async () => {
    refused(await run("txt", `import notes from ${JSON.stringify(join(project, "notes.txt"))};\nexport const X = () => <i>{notes}</i>;\n`), /not notes\.txt/);
  }, 60_000);

  test("another folder's node_modules/.cache is refused, data or code", async () => {
    refused(await run("cache", `import cached from ${JSON.stringify(otherCache)};\nexport const X = () => <i>{JSON.stringify(cached)}</i>;\n`), /not x\.json/);
    refused(await run("cache-code", `import cached from ${JSON.stringify(otherCode)};\nexport const X = () => <i>{cached}</i>;\n`), /outside the preview, your project's aliased source, the project components it was given and the installed packages/);
  }, 60_000);

  test("project code outside the alias targets is refused, and so is a fetched file posing as a package", async () => {
    refused(await run("root-code", 'import { key } from "@/../secret.ts";\nexport const X = () => <i>{key}</i>;\n'), /outside the preview, your project's aliased source/);
    const dir = previewDir("read-fake-package", { "ui/x.tsx": 'export { X } from "../node_modules/evil/index.tsx";\n', "node_modules/evil/index.tsx": 'import creds from "../../../project/creds.json";\nexport const X = () => <i>{JSON.stringify(creds)}</i>;\n' });
    refused(await bundlePreview({ root: project, tsconfig: "tsconfig.json", dir, main: "ui/x.tsx", compose: { export: "X", props: {}, children: [] }, fallback: null }), /not creds\.json/);
  }, 60_000);

  test("a project component outside the alias targets is imported only when the preview was pointed at it", async () => {
    const card = write(join(project, "design/ui/card.tsx"), "export function Card(props: { children?: unknown }) { return <div>{props.children as never}</div>; }\n");
    const dir = previewDir("read-part", { "ui/x.tsx": `import { Card } from ${JSON.stringify(card)};\nexport function X() { return <Card>part</Card>; }\n` });
    const job = { root: project, tsconfig: "tsconfig.json", dir, main: "ui/x.tsx", compose: { export: "X", props: {}, children: [] }, fallback: null };
    refused(await bundlePreview(job), /the project components it was given/);
    expect("hash" in (await bundlePreview({ ...job, projectParts: [card] }))).toBe(true);
    // Being given one file is not being given its neighbours.
    refused(await bundlePreview({ ...job, projectParts: [join(project, "secret.ts")] }), /the project components it was given/);
  }, 60_000);

  test("a normal component import still bundles: the project's component, React and the preview's own files", async () => {
    const dir = previewDir("read-ok", { "ui/x.tsx": 'import { useState } from "react";\nimport { Button } from "@/components/ui/button";\nimport { label } from "./label";\nexport function X() { const [n] = useState(1); return <Button>{label}{n}</Button>; }\n', "ui/label.ts": 'export const label = "Go";\n' });
    const built = await bundlePreview({ root: project, tsconfig: "tsconfig.json", dir, main: "ui/x.tsx", compose: { export: "X", props: {}, children: [] }, fallback: null });
    expect("hash" in built).toBe(true);
  }, 60_000);
});
