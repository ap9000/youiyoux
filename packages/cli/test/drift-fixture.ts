/**
 * A fixture for `youiyoux check --diff`: examples/demo-app, synced (so its Tailwind theme
 * resolves shapes), with a package.json and one existing Radix dialog, committed to a
 * temporary git repo. `addDrift` then makes the change the tests check: a ghost-button
 * lookalike, a hex colour, rounded-[8px] and p-[12px] (both token values), and imports
 * from a second UI library. The demo's own violations stay committed and untouched.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import { main } from "../src/index.ts";

const run = promisify(execFile);
const EXAMPLES = join(import.meta.dirname, "../../../examples");

export const PACKAGE_JSON = `${JSON.stringify({ name: "demo-app", private: true, dependencies: { react: "19.0.0", "class-variance-authority": "0.7.1", tailwindcss: "4.1.0", "@radix-ui/react-dialog": "1.1.0", "@mui/material": "7.0.0" } }, null, 2)}\n`;

export const CONFIRM = `import * as Dialog from "@radix-ui/react-dialog";

export function Confirm() {
  return <Dialog.Root />;
}
`;

/** Looks like Button variant="ghost": same height, padding, radius and text, and ghost's colours. */
export const QUIET_BUTTON = `import type { ReactNode } from "react";

export function QuietButton({ children }: { children: ReactNode }) {
  return <button className="inline-flex h-9 items-center justify-center rounded-control px-3.5 text-label text-muted hover:bg-card hover:text-foreground">{children}</button>;
}
`;

export const PROMO = `import { Button as MuiButton } from "@mui/material";
import { Modal } from "@mui/material";

export function Promo() {
  return (
    <div className="rounded-[8px] p-[12px] gap-[13px]">
      <span style={{ color: "#4f46e5" }}>New</span>
      <MuiButton>Try it</MuiButton>
      <Modal open={false} />
    </div>
  );
}
`;

export interface Fixture {
  readonly dir: string;
  readonly app: string;
  git(...args: string[]): Promise<{ stdout: string }>;
}

export async function driftFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "youi drift "));
  const app = join(dir, "demo app");
  await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
  await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
  const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    if ((await main(["sync", "--project", app])) !== 0) throw new Error("youiyoux sync failed on the fixture");
  } finally {
    quiet.mockRestore();
  }
  await writeFile(join(app, "package.json"), PACKAGE_JSON);
  await writeFile(join(app, "components/confirm.tsx"), CONFIRM);
  const git = (...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: app });
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-qm", "init");
  return { dir, app, git };
}

/** The change under test. Returns the line the edited heading is on. */
export async function addDrift(app: string): Promise<{ headingLine: number }> {
  await writeFile(join(app, "components/quiet-button.tsx"), QUIET_BUTTON);
  await writeFile(join(app, "components/promo.tsx"), PROMO);
  const home = join(app, "app/index.tsx");
  const text = await readFile(home, "utf8");
  await writeFile(home, text.replace('<h1 className="text-label">Projects</h1>', '<h1 className="text-label text-[#c62828]">Projects</h1>'));
  return { headingLine: text.split("\n").findIndex((l) => l.includes("<h1")) + 1 };
}

/** Run the CLI and capture what it prints. */
export async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  try {
    return { code: await main(argv), out };
  } finally {
    spy.mockRestore();
  }
}

/** Untouched UI syntax debt and valid TypeScript which a TSX parser cannot read. */
export async function repoModeWithOldFailures(fixture: Fixture): Promise<void> {
  await rm(join(fixture.app, "youi.project.json"));
  await mkdir(join(fixture.app, "src"), {recursive: true});
  await writeFile(join(fixture.app, "components/broken.tsx"), 'export const Broken = () => <div broken={;\n');
  await writeFile(join(fixture.app, "src/serve.ts"), 'const value: unknown = 1;\nexport const count = <number>value;\n');
  await writeFile(join(fixture.app, "src/generic.ts"), 'export const identity = <T,>(value: T): T => value;\n');
  await fixture.git("add", "-A");
  await fixture.git("commit", "-qm", "existing syntax debt and non-UI TypeScript");
}
