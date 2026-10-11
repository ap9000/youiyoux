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
    if (!ts.sys.fileExists(path)) return new ModuleResolver(root, fallback);
    const read = ts.readConfigFile(path, ts.sys.readFile);
    if (read.error) return new ModuleResolver(root, fallback);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path);
    return new ModuleResolver(root, { ...fallback, ...parsed.options });
  }

  resolve(specifier: string, fromFile: string): ModuleResolution {
    const key = `${dirname(fromFile)}\0${specifier}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const result = this.ts.resolveModuleName(specifier, fromFile, this.options, this.ts.sys, this.cache).resolvedModule;
    let resolution: ModuleResolution;
    if (!result) resolution = /^[./]/.test(specifier) ? { kind: "unresolved", specifier } : { kind: "external", module: specifier };
    else if (result.isExternalLibraryImport || result.resolvedFileName.includes("/node_modules/")) resolution = { kind: "external", module: specifier };
    else resolution = { kind: "file", file: result.resolvedFileName };
    this.memo.set(key, resolution);
    return resolution;
  }
}
