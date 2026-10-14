/**
 * Fixture repos for `youiyoux report` and `npx youiyoux`, built at run time under os.tmpdir() so
 * nothing about them (planted secrets least of all) is ever committed:
 *
 * - single: a shadcn-style Next.js app (cva Button and a Radix Dialog in src/components/ui), a
 *   hand-styled button that looks like the kit's (near-duplicate), hardcoded colours the theme
 *   holds, and a second dialog library (Headless UI) beside the kit's.
 * - monorepo: a pnpm workspace with apps/web, apps/admin and packages/ui, and a tooling package
 *   with no UI files.
 * - medium: generated, about 800 source files and 150 components.
 *
 * `link` links this repo's React, Radix, cva and Tailwind (the scanner's node_modules), as the
 * render tests do, so the looks can be drawn.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { runReport, type ReportIo, type ReportOptions } from "../src/report/run.ts";

const SCANNER_MODULES = join(import.meta.dirname, "../../scanner/node_modules");
export const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "youi test", GIT_AUTHOR_EMAIL: "test@youi.invalid", GIT_COMMITTER_NAME: "youi test", GIT_COMMITTER_EMAIL: "test@youi.invalid" };

export interface FixtureRepo {
  readonly dir: string;
  write(file: string, text: string): void;
  /** Every file under the repo (outside .git and node_modules) with its size and mtime, to prove nothing else was written. */
  snapshot(): Map<string, string>;
  remove(): void;
}

export function fixtureRepo(prefix: string, files: Readonly<Record<string, string>>, options: { link?: boolean; git?: boolean; parent?: string } = {}): FixtureRepo {
  const dir = mkdtempSync(join(options.parent ?? tmpdir(), `youi-report-${prefix}-`));
  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  for (const [file, text] of Object.entries(files)) write(file, text);
  if (options.link) symlinkSync(SCANNER_MODULES, join(dir, "node_modules"));
  if (options.git !== false) {
    write(".gitignore", "node_modules\n");
    const run = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
    run("init", "-q", "-b", "main");
    run("add", "-A");
    run("commit", "-qm", "base");
  }
  const snapshot = (): Map<string, string> => {
    const found = new Map<string, string>();
    const walk = (at: string): void => {
      for (const name of readdirSync(at)) {
        if (name === ".git" || name === "node_modules") continue;
        const path = join(at, name);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path);
        else found.set(relative(dir, path), `${stat.size}:${stat.mtimeMs}`);
      }
    };
    walk(dir);
    return found;
  };
  return { dir, write, snapshot, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

const BUTTON = `import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

export const buttonVariants = cva("inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium", {
  variants: {
    variant: {
      default: "bg-primary text-white",
      ghost: "bg-transparent text-primary",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Button({ className = "", variant, asChild = false, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={buttonVariants({ variant, className })} {...props} />;
}
`;

const DIALOG = `import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";

export function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogContent({ className = "", ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Content data-slot="dialog-content" className={\`rounded-lg bg-white p-6 \${className}\`} {...props} />;
}
`;

const CARD = `import type { ComponentProps } from "react";

export function Card({ className = "", ...props }: ComponentProps<"div">) {
  return <div data-slot="card" className={\`rounded-lg border p-6 \${className}\`} {...props} />;
}
`;

const GLOBALS = `@import "tailwindcss";

@theme {
  --color-primary: #2563eb;
  --color-danger: #dc2626;
  --radius-control: 6px;
}
`;

/** The single-project fixture's files; `extra` adds or replaces some. */
export function singleFiles(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "acme-shop", private: true, dependencies: { react: "19.3.0", "react-dom": "19.3.0", "@radix-ui/react-dialog": "1.1.23", "@radix-ui/react-slot": "1.3.3", "class-variance-authority": "0.7.1", "@headlessui/react": "2.2.0", tailwindcss: "4.3.3" } }, null, 2),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["./src/*"] } } }, null, 2),
    "components.json": JSON.stringify({ style: "new-york", tailwind: { css: "src/app/globals.css" }, aliases: { components: "@/components", ui: "@/components/ui" } }, null, 2),
    "src/app/globals.css": GLOBALS,
    "src/app/layout.tsx": `import "./globals.css";\nimport type { ReactNode } from "react";\n\nexport default function RootLayout({ children }: { children: ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
    "src/components/ui/button.tsx": BUTTON,
    "src/components/ui/dialog.tsx": DIALOG,
    "src/components/ui/card.tsx": CARD,
    "src/components/fancy-button.tsx": `import type { ComponentProps } from "react";\n\nexport function FancyButton(props: ComponentProps<"button">) {\n  return <button type="button" className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium bg-[#2563eb] text-white" {...props} />;\n}\n`,
    "src/components/promo-modal.tsx": `import { Dialog } from "@headlessui/react";\n\nexport function PromoModal({ open }: { open: boolean }) {\n  return <Dialog open={open} onClose={() => undefined}><p className="text-[#dc2626]">Sale</p></Dialog>;\n}\n`,
    "src/app/page.tsx": `import { Button } from "@/components/ui/button";\nimport { Card } from "@/components/ui/card";\nimport { Dialog, DialogContent } from "@/components/ui/dialog";\nimport { FancyButton } from "@/components/fancy-button";\n\nexport default function Home() {\n  return (\n    <main>\n      <Card><Button>Buy</Button><Button variant="ghost">Later</Button></Card>\n      <Button>Add to cart</Button>\n      <FancyButton>Checkout</FancyButton>\n      <Dialog><DialogContent>Saved</DialogContent></Dialog>\n      <div className="border-[#dc2626]">Out of stock</div>\n    </main>\n  );\n}\n`,
    "src/app/settings/page.tsx": `import { Button } from "@/components/ui/button";\nimport { Dialog, DialogContent } from "@/components/ui/dialog";\n\nexport default function Settings() {\n  return (\n    <section>\n      <Button>Save</Button>\n      <Button variant="ghost">Cancel</Button>\n      <Dialog><DialogContent>Done</DialogContent></Dialog>\n    </section>\n  );\n}\n`,
    ...extra,
  };
}

/** apps/web and apps/admin each use packages/ui's Button; admin also hand-styles one; tools/scripts has no UI. */
export function monorepoFiles(): Record<string, string> {
  const app = (name: string, extra: Record<string, string>) => ({
    [`apps/${name}/package.json`]: JSON.stringify({ name: `@acme/${name}`, private: true, dependencies: { "@acme/ui": "workspace:*", react: "19.3.0" } }),
    [`apps/${name}/tsconfig.json`]: JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    [`apps/${name}/src/app.css`]: `@import "tailwindcss";\n@theme { --color-brand: #7c3aed; }\n`,
    [`apps/${name}/src/app.tsx`]: `import "./app.css";\nimport { Button } from "@acme/ui";\n\nexport function App() {\n  return <div><Button>${name} one</Button><Button>${name} two</Button><span className="text-[#7c3aed]">${name}</span></div>;\n}\n`,
    ...extra,
  });
  return {
    "package.json": JSON.stringify({ name: "acme-monorepo", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n  - tools/*\n",
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", private: true, dependencies: { "class-variance-authority": "0.7.1", react: "19.3.0" } }),
    "packages/ui/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    "packages/ui/src/index.ts": `export { Button } from "./button";\n`,
    "packages/ui/src/button.tsx": BUTTON.replace(/import \{ Slot \} from "@radix-ui\/react-slot";\n/, "").replace("const Comp = asChild ? Slot : \"button\";", "const Comp = \"button\";"),
    "tools/scripts/package.json": JSON.stringify({ name: "@acme/scripts", private: true }),
    "tools/scripts/build.js": "console.log('build');\n",
    ...app("web", {}),
    ...app("admin", { "apps/admin/src/save-button.tsx": `export function SaveButton() {\n  return <button type="button" className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium">Save</button>;\n}\n` }),
  };
}

/** About 800 source files: 150 components (cva buttons, cards, badges, inputs) and 650 screens using them. */
export function mediumFiles(): Record<string, string> {
  const files = singleFiles();
  const roles = ["Button", "Card", "Badge", "Input", "Panel"];
  for (let i = 0; i < 150; i++) {
    const role = roles[i % roles.length]!;
    const tag = role === "Input" ? "input" : role === "Button" ? "button" : "div";
    const size = 8 + (i % 7) * 2;
    files[`src/components/widgets/${role.toLowerCase()}-${i}.tsx`] = `import type { ComponentProps } from "react";\n\nexport function ${role}${i}({ className = "", ...props }: ComponentProps<"${tag}">) {\n  return <${tag} className={\`h-${size} px-${(i % 4) + 2} rounded-md text-sm \${className}\`} {...props} />;\n}\n`;
  }
  for (let i = 0; i < 650; i++) {
    const a = i % 150;
    const b = (i * 7) % 150;
    const name = (n: number): string => `${roles[n % roles.length]!}${n}`;
    const path = (n: number): string => `@/components/widgets/${roles[n % roles.length]!.toLowerCase()}-${n}`;
    files[`src/screens/section-${Math.floor(i / 50)}/screen-${i}.tsx`] = `import { ${name(a)} } from "${path(a)}";\n${b !== a ? `import { ${name(b)} } from "${path(b)}";\n` : ""}import { Button } from "@/components/ui/button";\n\nexport function Screen${i}() {\n  return (\n    <section className="p-4">\n      <${name(a)} />\n      ${b !== a ? `<${name(b)} />` : ""}\n      <Button variant="${i % 2 ? "ghost" : "default"}">Go ${i}</Button>\n      <p className="${i % 9 === 0 ? "text-[#2563eb]" : "text-sm"}">Screen ${i}</p>\n    </section>\n  );\n}\n`;
  }
  return files;
}

/** Run `youiyoux report` in-process, collecting what it prints, with no Chromium unless `browsers` is the real environment. */
export async function report(dir: string, options: ReportOptions = {}, io: ReportIo & { browsers?: "none" | "installed" } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { ...(io.env ?? process.env) };
  if (io.browsers !== "installed") {
    env.PLAYWRIGHT_BROWSERS_PATH = mkdtempSync(join(tmpdir(), "youi-no-browsers-"));
    delete env.YOUI_CHROMIUM;
  }
  const result = await runReport({ path: dir, ...options }, { interactive: false, download: async () => { throw new Error("the report tried to download Chromium"); }, ...io, env, print: (t) => out.push(t), error: (t) => err.push(t) });
  return { ...result, stdout: out.join("\n"), stderr: err.join("\n") };
}
