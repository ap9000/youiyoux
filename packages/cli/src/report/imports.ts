import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** Per project root: its compiler options and one resolution cache, read once per report. */
const resolvers = new Map<string, { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache }>();

function resolverOf(root: string): { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache } {
  let found = resolvers.get(root);
  if (!found) {
    const config = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json") ?? ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json");
    const read = config ? ts.readConfigFile(config, ts.sys.readFile) : null;
    const options = config && read && !read.error ? ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config)).options : {};
    found = { options, cache: ts.createModuleResolutionCache(root, (name) => name, options) };
    resolvers.set(root, found);
  }
  return found;
}

/** Forget cached compiler options (tests that rewrite a tsconfig between runs). */
export function clearImportCache(): void {
  resolvers.clear();
}

/** Use an inferred alias only when TypeScript resolves it to the actual keeper. */
export async function verifiedImport(root: string, keeper: string, from: string, suggested: string): Promise<string | null> {
  const { options, cache } = resolverOf(root);
  let local = relative(dirname(join(root, from)), join(root, keeper)).replaceAll("\\", "/").replace(/\.(tsx?|jsx?|mjs)$/, "");
  if (!local.startsWith(".")) local = `./${local}`;
  for (const specifier of new Set([suggested, local])) {
    const found = ts.resolveModuleName(specifier, resolve(root, from), options, ts.sys, cache).resolvedModule?.resolvedFileName;
    if (found) {
      try { if (realpathSync(found) === realpathSync(join(root, keeper))) return specifier; } catch { /* Name the keeper file instead. */ }
    }
  }
  return null;
}
