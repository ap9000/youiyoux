import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { parseAddedLines, stagedChange, workingTreeChange } from "../src/index.ts";
import { addDrift, cli, driftFixture, repoModeWithOldFailures, type Fixture } from "./drift-fixture.ts";

const run = promisify(execFile);
const EXAMPLES = join(import.meta.dirname, "../../../examples");

let dir = "";
let app = "";
const git = (...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: app });

const savedEnv = { ...process.env };
beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_CONFIG")) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
});
afterAll(() => {
  process.env = savedEnv;
});

describe("parseAddedLines", () => {
  test("reads the new side of -U0 hunks: counts, single lines, deletions and quoted paths", () => {
    const diff = [
      "diff --git a.tsx a.tsx",
      "--- a.tsx",
      "+++ a.tsx",
      "@@ -3,0 +4,2 @@ x",
      "+one",
      "+two",
      "@@ -9 +11 @@",
      "-old",
      "+new",
      "@@ -20,3 +22,0 @@",
      "diff --git gone.tsx gone.tsx",
      "--- gone.tsx",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      'diff --git "caf\\303\\251 b.tsx" "caf\\303\\251 b.tsx"',
      '+++ "caf\\303\\251 b.tsx"',
      "@@ -0,0 +1 @@",
    ].join("\n");
    const added = parseAddedLines(diff);
    expect([...added.get("a.tsx")!]).toEqual([4, 5, 11]);
    expect(added.has("gone.tsx")).toBe(false);
    expect([...added.get("café b.tsx")!]).toEqual([1]);
  });
});

describe("the change git reports", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "youi diff "));
    app = join(dir, "demo app");
    await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
    await cp(join(EXAMPLES, "demo-design"), join(dir, "demo-design"), { recursive: true });
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-qm", "init");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("against HEAD: edited lines, untracked files whole, nothing for unchanged or unchecked files", async () => {
    const settings = join(app, "app/settings/index.tsx");
    const before = await readFile(settings, "utf8");
    await writeFile(settings, before.replace("<Button>Save</Button>", "<Button>Save now</Button>"));
    await writeFile(join(app, "components/new file.tsx"), "export const A = () => <p />;\n");
    await writeFile(join(app, "notes.md"), "not checked\n");
    const change = await workingTreeChange(await loadProject(app));
    expect(change.base).toBe("HEAD");
    const line = before.split("\n").findIndex((l) => l.includes("<Button>Save</Button>")) + 1;
    expect([...(change.added.get("app/settings/index.tsx") as Set<number>)]).toEqual([line]);
    expect(change.added.get("components/new file.tsx")).toBe("all");
    expect([...change.added.keys()].sort()).toEqual(["app/settings/index.tsx", "components/new file.tsx"]);
  });

  test("against a branch: the merge-base, so the branch's own commits count and the base's do not", async () => {
    await git("checkout", "-qb", "feature");
    await writeFile(join(app, "components/feature.tsx"), "export const F = () => <p />;\n");
    await git("add", "-A");
    await git("commit", "-qm", "feature");
    await git("checkout", "-q", "main");
    await writeFile(join(app, "components/later-on-main.tsx"), "export const M = () => <p />;\n");
    await git("add", "-A");
    await git("commit", "-qm", "main moves on");
    await git("checkout", "-q", "feature");
    const change = await workingTreeChange(await loadProject(app), "main");
    expect(change.base).toMatch(/^main \(merge-base [0-9a-f]{7}\)$/);
    expect([...change.added.keys()]).toEqual(["components/feature.tsx"]);
    await expect(workingTreeChange(await loadProject(app), "no-such-branch")).rejects.toThrow(/not a commit or branch/);
  });

  test("a renamed file adds only its edited lines", async () => {
    const from = join(app, "components/invite-form.tsx");
    const text = await readFile(from, "utf8");
    await rename(from, join(app, "components/invite-form-renamed.tsx"));
    await writeFile(join(app, "components/invite-form-renamed.tsx"), text.replace("Invite people", "Invite your team"));
    await git("add", "-A");
    const change = await workingTreeChange(await loadProject(app));
    const line = text.split("\n").findIndex((l) => l.includes("Invite people")) + 1;
    expect([...(change.added.get("components/invite-form-renamed.tsx") as Set<number>)]).toEqual([line]);
    expect(change.added.has("components/invite-form.tsx")).toBe(false);
  });

  test("staged: the index against HEAD, with the staged content", async () => {
    await writeFile(join(app, "components/staged.tsx"), "export const S = () => <p />;\n");
    await git("add", "components/staged.tsx");
    await writeFile(join(app, "components/staged.tsx"), "export const S = () => <p>edited after staging</p>;\n");
    const change = await stagedChange(await loadProject(app));
    expect([...(change.added.get("components/staged.tsx") as Set<number>)]).toEqual([1]);
    expect(change.sources?.["components/staged.tsx"]).toBe("export const S = () => <p />;\n");
  });

  test("outside git it stops and says why", async () => {
    await rm(join(app, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await expect(workingTreeChange(await loadProject(app))).rejects.toThrow(/needs a git checkout/);
  });
});

interface DiffJson {
  base: string;
  files: string[];
  findings: Array<{ kind: string; file: string; line: number; column: number; message: string; fix: string; rule?: string }>;
  incomplete: boolean;
  gaps: string[];
  next: string;
}

describe("youiyoux check --diff on a change", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await driftFixture();
  }, 60_000);
  afterEach(async () => {
    await rm(fixture.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const check = async (...args: string[]) => cli(["check", "--diff", ...args, "--project", fixture.app]);

  test("a clean change: No drift, exit 0, even with --strict; the demo's own violations are not reported", async () => {
    const settings = join(fixture.app, "app/settings/index.tsx");
    await writeFile(settings, (await readFile(settings, "utf8")).replace("<Button>Save</Button>", "<Button>Save now</Button>"));
    const text = await check();
    expect(text.code).toBe(0);
    expect(text.out).toContain("No drift in this change");
    expect(text.out).not.toContain("#c62828"); // committed in the demo, on an unchanged line
    expect((await check("--strict")).code).toBe(0);
    const { out } = await check("--json");
    expect(JSON.parse(out)).toMatchObject({ base: "HEAD", files: ["app/settings/index.tsx"], findings: [], incomplete: false, next: "nothing to fix" });
  });

  test("composition reuses Button and passes strict, while a raw root is still drift", async () => {
    await writeFile(join(fixture.app, "components/promo-card.tsx"), 'import { Button } from "@/components/ui";\nexport function PromoCard() { return <Button variant="ghost">Promo</Button>; }\n');
    const result = await check("--strict", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).findings).toEqual([]);
    await addDrift(fixture.app);
    const findings = JSON.parse((await check("--json")).out).findings;
    expect(findings.filter((f: {kind: string}) => f.kind === "near-duplicate").map((f: {file: string}) => f.file)).toEqual(["components/quiet-button.tsx"]);
  });

  test("reports each kind of drift the change adds, with a concrete fix, and nothing for unchanged code", async () => {
    const { headingLine } = await addDrift(fixture.app);
    const { code, out } = await check("--json");
    expect(code).toBe(0); // advisory without --strict
    const result = JSON.parse(out) as DiffJson;
    expect(result.base).toBe("HEAD");
    expect(result.files).toEqual(["app/index.tsx", "components/promo.tsx", "components/quiet-button.tsx"]);
    expect(result.incomplete).toBe(false);
    const of = (kind: string) => result.findings.filter((f) => f.kind === kind);

    // A new component that near-duplicates an existing one: the fix names the component, its variant and its import.
    expect(of("near-duplicate")).toEqual([expect.objectContaining({ file: "components/quiet-button.tsx", line: 3, fix: 'use <Button variant="ghost"> from "@/components/ui"' })]);
    expect(of("near-duplicate")[0]!.message).toMatch(/QuietButton is a new button that looks like the existing Button variant="ghost".*Confirm it is the same role/);

    // Hardcoded colour, radius and spacing, each naming its token; 13px matches no token and is not reported.
    const values = of("hardcoded-value");
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "app/index.tsx", line: headingLine, fix: "use text-danger (color.danger)", rule: "color.no-raw-color" }),
        expect.objectContaining({ file: "components/promo.tsx", line: 6, fix: "use rounded-control (radius.control, var(--demo-radius-control))" }),
        expect.objectContaining({ file: "components/promo.tsx", line: 6, fix: "use p-[var(--demo-space-md)] (space.md)" }),
        expect.objectContaining({ file: "components/promo.tsx", line: 7, fix: "use var(--demo-color-brand) (color.brand)" }),
      ]),
    );
    expect(values).toHaveLength(4);
    expect(out).not.toContain("gap-[13px]");

    // Imports from another UI library: the System's Button for a button, the project's Radix dialog for a dialog.
    expect(of("off-library")).toEqual([
      expect.objectContaining({ file: "components/promo.tsx", line: 1, fix: 'import { Button } from "@/components/ui"' }),
      expect.objectContaining({ file: "components/promo.tsx", line: 2, fix: 'use the dialog from "@radix-ui/react-dialog" instead, as the existing import does' }),
    ]);
    expect(of("off-library")[0]!.message).toContain("MUI");

    // Every finding is on a line the change added: never in unchanged files, never on the demo's committed violations.
    for (const f of result.findings) expect(f.fix.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => result.files.includes(f.file))).toBe(true);
    expect(result.findings.filter((f) => f.file === "app/index.tsx").map((f) => f.line)).toEqual([headingLine]);
    expect(result.next).toMatch(/apply each finding's fix/);
  });

  test("text says what to do next; --strict exits 1 on findings; --format github annotates the added lines", async () => {
    await addDrift(fixture.app);
    const text = await check();
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/✖ \d+ findings in this change: apply each fix/);
    expect(text.out).toContain('→ use <Button variant="ghost"> from "@/components/ui"');
    expect((await check("--strict")).code).toBe(1);
    const strict = await check("--strict", "--format", "github");
    expect(strict.out).toMatch(/::error file=components\/promo\.tsx,line=6,col=\d+,title=youi hardcoded value/);
    expect(strict.out).toContain("::warning file=components/quiet-button.tsx,line=3");
    // Advisory (no --strict) passes, so none of its notes is marked an error.
    const advisory = await check("--format", "github");
    expect(advisory.code).toBe(0);
    expect(advisory.out).toMatch(/::warning file=components\/promo\.tsx,line=6,col=\d+,title=youi hardcoded value/);
    expect(advisory.out).not.toContain("::error");
  });

  test("off-library fixes prefer the existing owned wrapper and its alias", async () => {
    await writeFile(join(fixture.app, "tsconfig.json"), JSON.stringify({compilerOptions: {paths: {"@/*": ["./*"]}}}));
    await mkdir(join(fixture.app, "components/ui"), {recursive: true});
    await writeFile(join(fixture.app, "components/ui/dialog.tsx"), 'import * as Primitive from "@radix-ui/react-dialog";\nexport const Dialog = Primitive.Root;\n');
    await writeFile(join(fixture.app, "components/wrapped.tsx"), 'import { Dialog } from "@/components/ui/dialog";\nexport const Wrapped = () => <Dialog />;\n');
    await fixture.git("add", "-A");
    await fixture.git("commit", "-qm", "wrapper");
    await addDrift(fixture.app);
    const result = JSON.parse((await check("--json")).out) as DiffJson;
    expect(result.findings.find((f) => f.kind === "off-library" && f.line === 2)?.fix).toBe('import { Dialog } from "@/components/ui/dialog"');
  });

  test("wrapper choice prefers owned files, then usage, and uses a relative import without an alias", async () => {
    await writeFile(join(fixture.app, "tsconfig.json"), '{}');
    const wrapper = 'import * as Primitive from "@radix-ui/react-dialog";\nexport const Dialog = Primitive.Root;\n';
    await writeFile(join(fixture.app, "components/ui/dialog-a.tsx"), wrapper);
    await writeFile(join(fixture.app, "components/ui/dialog-b.tsx"), wrapper);
    await writeFile(join(fixture.app, "components/dialog-other.tsx"), wrapper);
    await writeFile(join(fixture.app, "components/use-dialog.tsx"), 'import { Dialog } from "./ui/dialog-b";\nexport const UsesDialog = () => <Dialog />;\n');
    await fixture.git("add", "-A");
    await fixture.git("commit", "-qm", "wrappers");
    await addDrift(fixture.app);
    const result = JSON.parse((await check("--json")).out) as DiffJson;
    expect(result.findings.find((f) => f.kind === "off-library" && f.line === 2)?.fix).toBe('import { Dialog } from "./ui/dialog-b"');
  });

  test("without a project config, infers drift with theme variable fixes", async () => {
    await rm(join(fixture.app, "youi.project.json"));
    await writeFile(join(fixture.app, "theme.css"), ':root { --color-brand: #4f46e5; --radius-card: 8px; --spacing-card: 12px; }\n');
    await fixture.git("add", "-A");
    await fixture.git("commit", "-qm", "repo mode");
    await addDrift(fixture.app);
    const result = await check("--strict", "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as DiffJson;
    expect(report.incomplete).toBe(false);
    expect(report.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["near-duplicate", "hardcoded-value", "off-library"]));
    expect(report.findings.some((f) => f.fix.includes("var(--color-brand)"))).toBe(true);
    expect(report.findings.some((f) => f.fix.includes("var(--radius-card)"))).toBe(true);
    expect(report.findings.every((f) => f.fix.length > 0)).toBe(true);
  });

  test("repo mode ignores untouched failures and non-UI TypeScript on clean edits", async () => {
    await repoModeWithOldFailures(fixture);
    expect((await check("--strict")).code).toBe(0);
    const home = join(fixture.app, "app/index.tsx");
    await writeFile(home, (await readFile(home, "utf8")).replace("Projects</h1>", "My projects</h1>"));
    await writeFile(join(fixture.app, "src/serve.ts"), 'const value: unknown = 2;\nexport const count = <number>value;\n');
    const result = await check("--strict", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({incomplete: false, findings: []});
    expect(result.out).not.toContain("broken.tsx");
    const text = await check("--strict");
    expect(text.code).toBe(0);
    expect(text.out).toContain("No drift");
    expect(text.out).not.toContain("syntax errors");
  });

  test("repo mode accepts only a composing PromoCard despite untouched syntax debt", async () => {
    await repoModeWithOldFailures(fixture);
    await writeFile(join(fixture.app, "components/promo-card.tsx"), 'import { Button } from "@/components/ui";\nexport const PromoCard = () => <Button>Buy</Button>;\n');
    const result = await check("--strict", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({incomplete: false, findings: []});
  });

  test("repo mode reports a changed broken UI file as incomplete", async () => {
    await repoModeWithOldFailures(fixture);
    await writeFile(join(fixture.app, "components/broken.tsx"), 'export const Broken = () => <span broken={;\n');
    const result = await check("--strict", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).incomplete).toBe(true);
    expect(result.out).toContain("components/broken.tsx");
    expect(result.out).not.toContain("src/serve.ts");
  });

  test("repo mode does not suggest Tailwind defaults as project tokens", async () => {
    await rm(join(fixture.app, "youi.project.json"));
    await writeFile(join(fixture.app, "components/spacing.tsx"), 'export const Spacing = () => <section className="p-[4px] rounded-[6px]" />;\n');
    const report = JSON.parse((await check("--json")).out) as DiffJson;
    expect(report.findings.filter((f) => f.file === "components/spacing.tsx")).toEqual([]);
  });

  test("a repo without checked UI files is incomplete and names setup", async () => {
    const empty = await mkdtemp(join(tmpdir(), "youi-empty-"));
    try {
      await run("git", ["init", "-q"], {cwd: empty});
      const result = await cli(["check", "--diff", "--strict", "--json", "--project", empty]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out)).toMatchObject({incomplete: true, findings: []});
      expect(result.out).toContain("youiyoux init --design <dir>");
    } finally { await rm(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  test("repo mode outside git gives the exact setup step and fails strict", async () => {
    await rm(join(fixture.app, "youi.project.json"));
    await rm(join(fixture.app, ".git"), { recursive: true, maxRetries: 5, retryDelay: 100 });
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
    const result = await check("--strict");
    spy.mockRestore();
    expect(result.code).toBe(1);
    expect(errors.join("")).toContain("git init");
  });

  test("against a branch: only what the branch adds since the merge-base", async () => {
    await fixture.git("checkout", "-qb", "feature");
    await addDrift(fixture.app);
    await fixture.git("add", "-A");
    await fixture.git("commit", "-qm", "feature");
    const onBranch = JSON.parse((await check("main", "--json")).out) as DiffJson;
    expect(onBranch.base).toMatch(/^main \(merge-base [0-9a-f]{7}\)$/);
    expect(onBranch.findings.some((f) => f.kind === "near-duplicate")).toBe(true);
    // Against HEAD the committed change is no longer new.
    expect(JSON.parse((await check("--json")).out)).toMatchObject({ files: [], findings: [] });
    expect((await cli(["check", "--diff=main", "--json", "--project", fixture.app])).out).toContain("near-duplicate");
    // Nothing changed: against HEAD it suggests a branch; against a branch it already is one.
    expect((await check()).out).toContain("nothing to check. Compare with a branch: youiyoux check --diff main");
    await fixture.git("checkout", "-qb", "docs-only", "main");
    expect((await check("main")).out).toMatch(/✓ No checked files changed against main \(merge-base [0-9a-f]{7}\): nothing to check$/m);
  });

  test("without git it stops and says why, never a pass", async () => {
    await rm(join(fixture.app, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    });
    const { code, out } = await check("--strict");
    spy.mockRestore();
    expect(code).toBe(1);
    expect(out).not.toContain("No drift");
    expect(errors.join("")).toContain("needs a git checkout");
  });
});

describe("youiyoux check --diff on an agent's page, in a Tailwind 4 repo with no project config", () => {
  let repo = "";
  const BUTTON = 'import { cva } from "class-variance-authority";\n\nexport const buttonVariants = cva("inline-flex items-center rounded-md font-medium", {\n  variants: { size: { md: "h-10 px-4 text-sm" }, tone: { primary: "bg-primary text-white" } },\n  defaultVariants: { size: "md", tone: "primary" },\n});\n\nexport function Button({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {\n  return <button className={buttonVariants({ className })} {...props} />;\n}\n';
  const HAND_BUILT = 'className="inline-flex items-center rounded-md font-medium h-10 px-4 text-sm bg-primary text-white"';
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "youi-page-"));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "acme-app", private: true, dependencies: { react: "19.0.0", tailwindcss: "4.1.0", "class-variance-authority": "0.7.1" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve", paths: { "@/*": ["./src/*"] } } }),
      "src/app/globals.css": '@import "tailwindcss";\n@theme {\n  --color-primary: #4f46e5;\n  --color-muted: #6b7280;\n  --radius-md: 6px;\n}\n',
      "src/components/ui/button.tsx": BUTTON,
      "src/app/settings/page.tsx": 'import { Button } from "@/components/ui/button";\n\nexport default function Settings() {\n  return <form><Button>Save</Button></form>;\n}\n',
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(join(repo, file, ".."), { recursive: true });
      await writeFile(join(repo, file), text);
    }
    const g = (...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
    await g("init", "-q", "-b", "main");
    await g("add", "-A");
    await g("commit", "-qm", "init");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const check = async () => JSON.parse((await cli(["check", "--diff", "--json", "--project", repo])).out) as DiffJson;

  test("a hand-styled <button> in a page that looks like Button is caught at the element, with Button's import; a different shape is not", async () => {
    await mkdir(join(repo, "src/app/team"), { recursive: true });
    await writeFile(join(repo, "src/app/team/page.tsx"), `export default function Team() {\n  return (\n    <section>\n      <h1>Team</h1>\n      <button ${HAND_BUILT}>Invite</button>\n      <button className="inline-flex h-6 px-1 text-xs">Copy link</button>\n    </section>\n  );\n}\n`);
    const near = (await check()).findings.filter((f) => f.kind === "near-duplicate");
    expect(near).toEqual([expect.objectContaining({ file: "src/app/team/page.tsx", line: 5, column: 7, fix: 'use <Button> from "@/components/ui/button"' })]);
    expect(near[0]!.message).toBe("A hand-styled <button> that looks like the existing Button (src/app/settings/page.tsx:4): 40px high, 16px side padding, 6px radius, 14px text. Confirm it is the same role; if so, render Button instead.");
  });

  test("a new component built on the same hand-styled root is one finding, at the component", async () => {
    await writeFile(join(repo, "src/components/invite-button.tsx"), `export function InviteButton() {\n  return <button ${HAND_BUILT}>Invite</button>;\n}\n`);
    const near = (await check()).findings.filter((f) => f.kind === "near-duplicate");
    expect(near).toEqual([expect.objectContaining({ file: "src/components/invite-button.tsx", line: 1, fix: 'use <Button> from "@/components/ui/button"' })]);
  });

  test("a component that holds the copy (a toolbar) is not itself a button: the copy is reported where it is", async () => {
    await writeFile(join(repo, "src/components/save-bar.tsx"), `export function SaveBar() {\n  return (\n    <div className="flex gap-2">\n      <button ${HAND_BUILT}>Save</button>\n    </div>\n  );\n}\n`);
    const near = (await check()).findings.filter((f) => f.kind === "near-duplicate");
    expect(near).toEqual([expect.objectContaining({ file: "src/components/save-bar.tsx", line: 4, fix: 'use <Button> from "@/components/ui/button"' })]);
    expect(near[0]!.message).toMatch(/^A hand-styled <button> that looks like the existing Button/);
  });

  test("a colour an @theme variable holds is fixed with its Tailwind class, named without the repeated group", async () => {
    await writeFile(join(repo, "src/app/settings/note.tsx"), 'export const Note = () => <p className="text-[#6b7280]">Billed monthly.</p>;\n');
    const values = (await check()).findings.filter((f) => f.kind === "hardcoded-value");
    expect(values).toEqual([expect.objectContaining({ file: "src/app/settings/note.tsx", fix: "use text-muted (color.muted)", message: "Hardcoded colour #6b7280: the token color.muted has this value. Check it plays that role." })]);
  });

  test("a token named for phones is offered only in phone code: a media query, a selector or a variant; elsewhere a general one, or none", async () => {
    await writeFile(join(repo, "src/app/globals.css"), '@import "tailwindcss";\n@custom-variant phone (@media (max-width: 760px));\n@theme {\n  --color-primary: #4f46e5;\n  --spacing-phone-row: 8px;\n  --spacing-phone-card: 12px;\n}\n:root {\n  --space-sm: 8px;\n}\n');
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "tokens"], { cwd: repo });
    await writeFile(join(repo, "src/app/composer.css"), ".composer { padding: 8px 12px; }\n@media (max-width: 760px) {\n  .composer { padding: 8px 12px; }\n}\nhtml[data-mobile-keyboard] .composer { padding-bottom: 12px; }\n");
    await writeFile(join(repo, "src/app/row.tsx"), 'export const Row = () => <div className="flex gap-[8px] phone:gap-[8px] p-[12px]" />;\n');
    const fixes = (await check()).findings.filter((f) => f.kind === "hardcoded-value").map((f) => [f.file, f.line, f.fix]);
    expect(fixes).toEqual([
      // Desktop: 8px is the general --space-sm; 12px only a phone token has, so it stays.
      ["src/app/composer.css", 1, "use padding: var(--space-sm) 12px (spacing.space-sm)"],
      ["src/app/composer.css", 3, "use padding: var(--spacing-phone-row) var(--spacing-phone-card) (spacing.phone-row, spacing.phone-card)"],
      ["src/app/composer.css", 5, "use padding-bottom: var(--spacing-phone-card) (spacing.phone-card)"],
      ["src/app/row.tsx", 1, "use gap-[var(--space-sm)] (spacing.space-sm)"],
      ["src/app/row.tsx", 1, "use phone:gap-phone-row (spacing.phone-row or spacing.space-sm, var(--spacing-phone-row))"],
    ]);
  });
});
