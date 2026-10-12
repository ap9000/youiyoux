/**
 * Identity, not names: a JSX `<Button>` counts as the design-system Button only
 * if its import resolves (TypeScript module resolution, the project's own
 * tsconfig) through any barrels and aliases to the owned implementation.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as TS from "typescript";

export type ModuleResolution =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "external"; readonly module: string }
  | { readonly kind: "unresolved"; readonly specifier: string };

const require = createRequire(import.meta.url);
let tsModule: typeof TS | null = null;

/** TypeScript is ~10 MB of JS; load it only when a scan needs resolution. */
function typescript(): typeof TS {
  tsModule ??= require("typescript") as typeof TS;
  return tsModule;
}

export class ModuleResolver {
  private readonly ts: typeof TS;
  private readonly options: TS.CompilerOptions;
  private readonly cache: TS.ModuleResolutionCache;
  private readonly memo = new Map<string, ModuleResolution>();

  private constructor(root: string, options: TS.CompilerOptions) {
    this.ts = typescript();
    this.options = options;
    this.cache = this.ts.createModuleResolutionCache(root, (f) => f, options);
  }

  /** Why resolution may be degraded (missing or invalid tsconfig); a scan reports these as partial. */
  problems: string[] = [];

  static create(root: string, tsconfig: string): ModuleResolver {
    const ts = typescript();
    const path = join(root, tsconfig);
    const fallback: TS.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      baseUrl: root,
    };
    const degraded = (problem: string): ModuleResolver => {
      const resolver = new ModuleResolver(root, fallback);
      resolver.problems.push(problem);
      return resolver;
    };
    if (!ts.sys.fileExists(path)) return degraded(`${tsconfig} not found: path aliases cannot be resolved`);
    const read = ts.readConfigFile(path, ts.sys.readFile);
    if (read.error) return degraded(`${tsconfig} cannot be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path);
    const resolver = new ModuleResolver(root, { ...fallback, ...parsed.options });
    const fatal = parsed.errors.filter((e) => e.code !== 18003); // 18003: no inputs matched; irrelevant here
    if (fatal.length > 0) resolver.problems.push(`${tsconfig}: ${fatal.map((e) => ts.flattenDiagnosticMessageText(e.messageText, " ")).join("; ")}`);
    return resolver;
  }

  resolve(specifier: string, fromFile: string): ModuleResolution {
    const key = `${dirname(fromFile)}\0${specifier}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const result = this.ts.resolveModuleName(specifier, fromFile, this.options, this.ts.sys, this.cache).resolvedModule;
    let resolution: ModuleResolution;
    // TypeScript does not resolve plain CSS files. Let its own alias/path resolution
    // probe a virtual .css.ts file, then return the existing stylesheet it stands for.
    const css = !result && specifier.endsWith(".css") ? this.ts.resolveModuleName(specifier, fromFile, this.options, {
      ...this.ts.sys,
      fileExists: (file) => file.endsWith(".css.ts") && this.ts.sys.fileExists(file.slice(0, -3)),
    }).resolvedModule : undefined;
    // Relative paths and project aliases (@/x, ~/x, #x) that do not resolve are unknown, never "external".
    if (css && !css.isExternalLibraryImport && !css.resolvedFileName.includes("/node_modules/")) resolution = { kind: "file", file: css.resolvedFileName.slice(0, -3) };
    else if (!result) resolution = /^(?:[./]|@\/|~\/|#)/.test(specifier) ? { kind: "unresolved", specifier } : { kind: "external", module: specifier };
    else if (result.isExternalLibraryImport || result.resolvedFileName.includes("/node_modules/")) resolution = { kind: "external", module: specifier };
    else resolution = { kind: "file", file: result.resolvedFileName };
    this.memo.set(key, resolution);
    return resolution;
  }
}
