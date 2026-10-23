/** Filesystem helpers shared by the loader, scanner and sync. */
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as nodePath from "node:path";
import { dirname, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/** A validation or read failure that names the file and the failing field. */
export class DefinitionError extends Error {
  readonly file: string;
  readonly issues: readonly string[];
  constructor(file: string, issues: readonly string[]) {
    super(`${file}: ${issues.join("; ")}`);
    this.name = "DefinitionError";
    this.file = file;
    this.issues = issues;
  }
}

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Project-relative POSIX path. */
export function relPath(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}

/*
 * Node 20 has no fs.glob, and path.matchesGlob only from 20.17: the published youiyoux bundle
 * runs there, so a small matcher and walk stand in. Node 22 and later use their own.
 */
const nativeMatch = (nodePath as { matchesGlob?: (path: string, pattern: string) => boolean }).matchesGlob;
const nativeGlob = (fsp as { glob?: (pattern: string[], options: { cwd: string; exclude: (path: string) => boolean }) => AsyncIterable<string> }).glob;
const compiled = new Map<string, RegExp>();

/** A glob as a regular expression: `**` spans directories (zero or more), `*` and `?` stay in one, `{a,b}` and `[…]` as in a shell; `*` skips dot names. */
export function globRegExp(pattern: string): RegExp {
  let cached = compiled.get(pattern);
  if (cached) return cached;
  let out = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      const whole = (i === 0 || pattern[i - 1] === "/") && (i + 2 === pattern.length || pattern[i + 2] === "/");
      if (whole && pattern[i + 2] === "/") {
        out += "(?:(?!\\.)[^/]*/)*";
        i += 2;
      } else {
        out += whole ? "(?:(?!\\.)[^/]*(?:/(?!\\.)[^/]*)*)?" : "[^/]*";
        i += 1;
      }
    } else if (c === "*") out += (i === 0 || pattern[i - 1] === "/" ? "(?!\\.)" : "") + "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (c === "," && braces > 0) out += "|";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else {
        out += `[${pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else out += /[.+^$()|\\\]]/.test(c) ? `\\${c}` : c;
  }
  cached = new RegExp(`^${out}$`);
  compiled.set(pattern, cached);
  return cached;
}

const matchesGlob = nativeMatch ?? ((path: string, pattern: string): boolean => globRegExp(pattern).test(path));

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => path === pattern || matchesGlob(path, pattern));
}

/** fs.glob's files, for Node without it: a walk that never enters an excluded directory. */
export async function* walkGlob(include: readonly string[], options: { cwd: string; exclude: (path: string) => boolean }): AsyncIterable<string> {
  const pending = [""];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const entries = await readdir(join(options.cwd, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (options.exclude(path)) continue;
      // `dir/` meets `**/dir/**`, so an excluded directory is never entered.
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !options.exclude(`${path}/`)) pending.push(path);
      }
      else if (include.some((pattern) => matchesGlob(path, pattern))) yield path;
    }
  }
}

const ALWAYS_EXCLUDED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.youi/**"];

/** Files under `root` matching `include` and not `exclude`, sorted, as project-relative POSIX paths. */
export async function findFiles(root: string, include: readonly string[], exclude: readonly string[] = []): Promise<string[]> {
  const skip = [...ALWAYS_EXCLUDED, ...exclude];
  const found = new Set<string>();
  const options = { cwd: root, exclude: (p: string) => matchesAny(toPosix(p), skip) };
  for await (const entry of nativeGlob ? nativeGlob(include as string[], options) : walkGlob(include, options)) {
    const path = toPosix(entry);
    if (!matchesAny(path, skip)) found.add(path);
  }
  return [...found].sort();
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`);
}

/** Parse JSON or YAML text and validate it, failing with the file name and each issue. */
export function parseDefinition<T extends z.ZodType>(file: string, text: string, schema: T): z.infer<T> {
  let raw: unknown;
  try {
    raw = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (error: unknown) {
    throw new DefinitionError(file, [`not valid ${file.endsWith(".json") ? "JSON" : "YAML"}: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new DefinitionError(file, issuesOf(result.error));
  return result.data;
}

export async function readDefinition<T extends z.ZodType>(file: string, schema: T, displayRoot?: string): Promise<z.infer<T>> {
  const label = displayRoot ? relPath(displayRoot, file) : file;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error: unknown) {
    throw new DefinitionError(label, [`cannot read: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return parseDefinition(label, text, schema);
}

/**
 * The nearest directory from `start` upward that holds `file`, or null. The walk stops at the top
 * of the git repository `start` is in (the directory holding `.git`), so a config from an
 * enclosing repository, or from the home directory above it, is never picked up.
 */
export function findUp(start: string, file: string): string | null {
  for (let dir = nodePath.resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, file))) return dir;
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return null;
  }
}

/** Write via a temp file and rename, so a reader never sees a half-written file. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}

export async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
