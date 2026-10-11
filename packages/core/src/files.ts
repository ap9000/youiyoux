/** Filesystem helpers shared by the loader, scanner and sync. */
import { glob, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, matchesGlob, relative, sep } from "node:path";
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

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => path === pattern || matchesGlob(path, pattern));
}

const ALWAYS_EXCLUDED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.youi/**"];

/** Files under `root` matching `include` and not `exclude`, sorted, as project-relative POSIX paths. */
export async function findFiles(root: string, include: readonly string[], exclude: readonly string[] = []): Promise<string[]> {
  const skip = [...ALWAYS_EXCLUDED, ...exclude];
  const found = new Set<string>();
  for await (const entry of glob(include as string[], { cwd: root, exclude: (p: string) => matchesAny(toPosix(p), skip) })) {
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
