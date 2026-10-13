/**
 * The `eyes` fixture as a git repository in a temporary directory, its base committed on main,
 * its packages linked from this package's node_modules, as the specimen tests link theirs. Git
 * never reads the developer's own configuration. Used by the scanner, CLI and MCP render tests.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EYES = join(import.meta.dirname, "fixtures/inventory/eyes");
const SCANNER_MODULES = join(import.meta.dirname, "../node_modules");

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "youi test", GIT_AUTHOR_EMAIL: "test@youi.invalid", GIT_COMMITTER_NAME: "youi test", GIT_COMMITTER_EMAIL: "test@youi.invalid" };

export interface EyesRepo {
  readonly dir: string;
  /** A file's text, project-relative. */
  read(file: string): string;
  /** Replace `from` with `to` in a project-relative file; throws when `from` is not in it. */
  edit(file: string, from: string, to: string): void;
  write(file: string, text: string): void;
  remove(): void;
}

/** A copy of the fixture: committed as the base on main unless `git` is false. */
export function eyesRepo({ git = true, a11y = false }: { git?: boolean; a11y?: boolean } = {}): EyesRepo {
  const dir = mkdtempSync(join(tmpdir(), "youi-eyes-"));
  cpSync(EYES, dir, { recursive: true, filter: (source) => !source.split(/[\\/]/).includes("node_modules") });
  symlinkSync(SCANNER_MODULES, join(dir, "node_modules"));
  if (a11y) {
    const app = join(dir, "src/app.tsx");
    writeFileSync(app, readFileSync(app, "utf8") + `
import { IconButton } from "./components/icon-button";
import { RadioCard } from "./components/radio-card";
import { LinkedButton } from "./components/linked-button";
import { RadioGroup } from "./components/radio-group";
export function PlanChoice({ id, title }: { id: string; title: string }) { return <RadioCard id={id} title={title} />; }
export function Controls({ label }: { label: string }) {
  return <div><LinkedButton aria-labelledby={label} /><IconButton aria-label={label}>{label}</IconButton><RadioGroup>{[{id: "plan", title: label}].map(p => <RadioCard key={p.id} id={p.id} title={p.title} />)}<PlanChoice id={label} title={label} /></RadioGroup></div>;
}
`);
  }
  if (git) {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    const run = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
    run("init", "-q", "-b", "main");
    run("add", "-A");
    run("commit", "-qm", "base");
  }
  const read = (file: string): string => readFileSync(join(dir, file), "utf8");
  return {
    dir,
    read,
    edit(file, from, to) {
      const text = read(file);
      if (!text.includes(from)) throw new Error(`${file} has no ${from}`);
      writeFileSync(join(dir, file), text.replace(from, to));
    },
    write: (file, text) => writeFileSync(join(dir, file), text),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The unlabelled search field: its aria-label and placeholder gone (axe's `label`), its border pink and 2px (a visible change). */
export function unlabelSearch(repo: EyesRepo): void {
  repo.edit("src/components/search-input.tsx", ' aria-label="Search" placeholder="Search"', "");
  repo.edit("src/components/search-input.tsx", "border border-slate-400", "border-2 border-pink-500");
}

/** A PNG's width and height, from its IHDR chunk. */
export function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** One fixed name issue, one newly unlabelled radio and one new contrast failure. */
export function regressRadio(repo: EyesRepo): void {
  repo.edit("src/components/radio-card.tsx", '<label htmlFor={id}>{title}</label>', '');
  repo.edit("src/components/radio-card.tsx", '<button type="button">', '<button type="button" aria-label="Add">');
  repo.edit("src/components/radio-card.tsx", '<span className="text-black">', '<span className="text-gray-200">');
}
