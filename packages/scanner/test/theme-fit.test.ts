/** Theme fit against the console fixture's own theme, with recorded registry items (no network). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { classWords, projectTheme, themeFit } from "../src/index.ts";

const CONSOLE = join(import.meta.dirname, "fixtures/inventory/console");
const HTTP = join(import.meta.dirname, "../../discover/test/fixtures/http");
const item = (file: string): { sources: string[]; cssVars: Record<string, Record<string, string>> | null } => {
  const json = JSON.parse(readFileSync(join(HTTP, file), "utf8")) as { files: Array<{ content: string }>; cssVars?: Record<string, Record<string, string>> };
  return { sources: json.files.map((f) => f.content), cssVars: json.cssVars ?? null };
};

let project: Awaited<ReturnType<typeof projectTheme>>;
beforeAll(async () => {
  project = await projectTheme(CONSOLE);
});

test("classes are read from quoted strings with their variants stripped", () => {
  expect(classWords(['cn("md:text-sm hover:bg-primary/90 [&_svg]:size-4 !rounded-md", x)'])).toEqual(["text-sm", "bg-primary/90", "size-4", "rounded-md"]);
});

test("shadcn's command: its radius takes the console's 8px, popover colours are not themed, its type matches", () => {
  const command = item("shadcn-item-command.json");
  const fit = themeFit({ theme: project.theme, item: command.sources, project: project.sources, cssVars: command.cssVars });
  expect(fit.themed).toContain("rounded-md draws with your --radius-md: 8px (Tailwind's default is 6px)");
  expect(fit.radius).toBe(8);
  expect(fit.themed).toEqual(expect.arrayContaining([expect.stringMatching(/^colours: your .*accent.*muted-foreground/), "type face: your --font-sans (Console Mono)"]));
  expect(fit.unthemed).toEqual(expect.arrayContaining(["bg-popover: your theme has no --color-popover, so it draws with no colour", "text-popover-foreground: your theme has no --color-popover-foreground, so it draws with no colour", "bg-border: your theme has no --color-border, so it draws with no colour"]));
  expect(fit.type).toEqual({ item: 14, project: 14 });
  expect(fit.themed).toContain("14px type (text-sm), as your project uses");
});

test("a bigger type size than the project's is said plainly", () => {
  const fit = themeFit({ theme: project.theme, item: ['<p className="text-base">', '<span className="text-base">', '<b className="text-xs">'], project: project.sources });
  expect(fit.unthemed).toContain("16px type (text-base), project uses 14px (text-sm)");
});

test("fixed values and the variables an item brings are not themed", () => {
  const coss = item("coss-item-button.json");
  const fit = themeFit({ theme: project.theme, item: [...coss.sources, '"rounded-[10px] text-[13px] bg-red-600"'], project: project.sources, cssVars: coss.cssVars });
  expect(fit.unthemed).toEqual(expect.arrayContaining([
    "rounded-[10px] is a fixed radius (10px), not one of your tokens",
    "text-[13px] is a fixed size, not one of your type steps",
    expect.stringMatching(/bg-red-600.*: (?:a fixed colour|fixed colours), not your tokens/),
    "it brings its own --destructive-foreground (light and dark): your theme has no such variable, so it would be added on install",
  ]));
});

test("an arbitrary width is not called a colour; an arbitrary colour is", () => {
  const fit = themeFit({ theme: project.theme, item: ['"focus-visible:ring-[3px] border-[2px] outline-(--x) bg-clip-padding bg-origin-border"'], project: project.sources });
  expect(fit.unthemed.filter((line) => /colour/.test(line))).toEqual([]);
  const coloured = themeFit({ theme: project.theme, item: ['"bg-[#0a0a0a] ring-[oklch(0.7_0.1_200)] ring-[3px]"'], project: project.sources });
  expect(coloured.unthemed).toContain("bg-[#0a0a0a], ring-[oklch(0.7_0.1_200)]: fixed colours, not your tokens");
  expect(themeFit({ theme: project.theme, item: ['"text-[color:var(--x)]"'], project: project.sources }).unthemed).toContain("text-[color:var(--x)]: a fixed colour, not your tokens");
});
