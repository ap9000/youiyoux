/**
 * @tailwindcss/forms gives text inputs, selects and text areas their own padding, text size and
 * border: a control with no padding class is not 0px wide inside. Read from CSS (Tailwind 4), the
 * Tailwind config, or a preset in a workspace package; when it is installed but its use cannot be
 * read, the unstyled padding is unknown, never 0.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { buildInventory } from "../src/index.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "youi-forms-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

const app = (dir: string, deps: Record<string, string> = {}): Record<string, string> => ({
  [`${dir}package.json`]: JSON.stringify({ name: "app", dependencies: { react: "19.3.0", tailwindcss: "3.4.17", ...deps } }),
  [`${dir}tsconfig.json`]: JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
  [`${dir}src/form.tsx`]: 'export function Form() {\n  return <form><input className="w-full rounded-md border-gray-300" /><input className="form-input rounded-md" /><select className="rounded-md" /></form>;\n}\n',
});

const shapes = async (root: string): Promise<Array<[string, number | null, number | null, number | null]>> => {
  const report = await buildInventory([root]);
  return report.looks.filter((l) => l.role === "input").map((l) => [`${l.tag}:${l.line}:${l.column}`, l.shape.paddingX, l.shape.height, l.shape.fontSize]);
};

describe("@tailwindcss/forms", () => {
  test("without it, Tailwind's reset leaves an unstyled form control 0px inside", async () => {
    expect((await shapes(repo({ ...app(""), "src/styles.css": "@tailwind base;\n" }))).map((s) => s[1])).toEqual([0, 0, 0]);
  });

  test("with it (Tailwind 4 @plugin): 12px by 8px padding, 16px text, 42px high; a select keeps room for its arrow", async () => {
    const root = repo({ ...app("", { tailwindcss: "4.3.3" }), "src/styles.css": '@import "tailwindcss";\n@plugin "@tailwindcss/forms";\n' });
    expect(await shapes(root)).toEqual([["input:2:16", 12, 42, 16], ["input:2:71", 12, 42, 16], ["select:2:114", 26, 42, 16]]);
  });

  test("in class mode only controls with a form-* class get it", async () => {
    const root = repo({ ...app("", { tailwindcss: "4.3.3" }), "src/styles.css": '@import "tailwindcss";\n@plugin "@tailwindcss/forms" { strategy: "class"; }\n' });
    expect((await shapes(root)).map((s) => s[1])).toEqual([0, 12, 0]);
  });

  test("from a Tailwind 3 preset in a workspace package, as dub has it", async () => {
    const root = repo({
      ...app("apps/web/"),
      "apps/web/tailwind.config.ts": 'import shared from "@acme/tailwind-config/tailwind.config";\nexport default { presets: [shared] };\n',
      "apps/web/src/styles.css": "@tailwind base;\n",
      "packages/tailwind-config/package.json": JSON.stringify({ name: "@acme/tailwind-config", dependencies: { "@tailwindcss/forms": "0.5.10" } }),
      "packages/tailwind-config/tailwind.config.ts": 'import forms from "@tailwindcss/forms";\nexport default { plugins: [forms] };\n',
    });
    expect((await shapes(join(root, "apps/web"))).map((s) => s[1])).toEqual([12, 12, 26]);
  });

  test("installed but not read as this project's: the unstyled padding is unknown, never 0", async () => {
    const root = repo({ ...app("", { "@tailwindcss/forms": "0.5.10" }), "src/styles.css": "@tailwind base;\n", "tailwind.config.js": "module.exports = { plugins: [require(process.env.PLUGIN)] };\n" });
    expect((await shapes(root)).map((s) => s[1])).toEqual([null, null, null]);
  });
});
