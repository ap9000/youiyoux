/**
 * Route attribution. A site's screen is known when its file is a route
 * (expo-router file path, or an explicit map entry with evidence) or when a
 * route file reaches it through imports; otherwise it is `unrouted`, which a
 * reader sees, rather than a guess.
 */
import { GLOB_SYNTAX, matchesAny, type RouteAttribution, type RouteConfig } from "@youiyoux/core";
import type { ModuleGraph } from "./graph.ts";
import type { ModuleInfo } from "./parse.ts";

const SHELL_ROUTE = "*";

/** `app/(tabs)/index.tsx` → `/`, `app/user/[id].tsx` → `/user/[id]`; null for layouts and specials. */
export function expoRoute(file: string, appDir: string): string | null {
  if (!file.startsWith(`${appDir}/`) || !/\.(tsx|ts|jsx|js)$/.test(file)) return null;
  const segments = file.slice(appDir.length + 1).replace(/\.(tsx|ts|jsx|js)$/, "").replace(/\.(web|native|ios|android)$/, "").split("/");
  const last = segments.at(-1)!;
  if (last === "_layout" || last.startsWith("+") && last !== "+not-found") return null;
  const visible = segments.filter((s) => !/^\(.*\)$/.test(s));
  if (visible.at(-1) === "index") visible.pop();
  return `/${visible.join("/")}`;
}

interface Entry {
  readonly routes: readonly string[];
  readonly shell: boolean;
}

function routeEntries(files: readonly string[], config: RouteConfig): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  // A map entry naming one file is looked up; only the globs are matched against every file.
  const exact = new Map<string, string[]>();
  const globs: RouteConfig["map"] = [];
  for (const m of config.strategy === "map" ? config.map : []) {
    if (GLOB_SYNTAX.test(m.file)) globs.push(m);
    else exact.set(m.file, [...(exact.get(m.file) ?? []), ...m.routes]);
  }
  for (const file of files) {
    if (matchesAny(file, config.shell)) {
      entries.set(file, { routes: [SHELL_ROUTE], shell: true });
      continue;
    }
    if (config.strategy === "expo-router") {
      const route = expoRoute(file, config.appDir);
      if (route) entries.set(file, { routes: [route], shell: false });
      else if (/\/_layout\.(tsx|ts|jsx|js)$/.test(file) && file.startsWith(`${config.appDir}/`)) {
        const dir = file.slice(0, file.lastIndexOf("/"));
        const below = files.map((f) => (f.startsWith(`${dir}/`) ? expoRoute(f, config.appDir) : null)).filter((r): r is string => r !== null);
        if (below.length > 0) entries.set(file, { routes: [...new Set(below)], shell: true });
      }
    }
    if (config.strategy === "map") {
      const routes = [...(exact.get(file) ?? []), ...globs.filter((m) => matchesAny(file, [m.file])).flatMap((m) => m.routes)];
      if (routes.length > 0) entries.set(file, { routes: [...new Set(routes)], shell: false });
    }
  }
  return entries;
}

/** A route may forward its default component through another route entry. */
function defaultTargets(module: ModuleInfo, graph: ModuleGraph): Set<string> {
  const targets = new Set<string>();
  for (const entry of module.exports) {
    if (entry.name !== "default") continue;
    const specifier = entry.kind === "reexport" ? entry.specifier : module.imports.find((i) => i.local === entry.local && !i.typeOnly)?.specifier;
    if (!specifier || !module.runtimeSpecifiers.includes(specifier)) continue;
    const target = graph.resolveSpecifier(specifier, module.file);
    if (target.kind === "file") targets.add(target.file);
  }
  return targets;
}

export class RouteIndex {
  private readonly attribution = new Map<string, RouteAttribution>();
  private readonly unroutedReason: string;

  constructor(unroutedReason = "No route or app shell reaches this file through scanned imports.") {
    this.unroutedReason = unroutedReason;
  }

  static build(graph: ModuleGraph, modules: ReadonlyMap<string, ModuleInfo | null>, config: RouteConfig): RouteIndex {
    if (config.strategy === "none" && config.shell.length === 0) return new RouteIndex("Route mapping is disabled in the project config.");
    const index = new RouteIndex();
    // Sorted: the map fills in parse-completion order, and route lists must not depend on it.
    const files = [...modules.keys()].sort();
    const scanned = new Set(files);
    const entries = routeEntries(files, config);
    const dependencies = new Map(files.map((file) => {
      const module = modules.get(file);
      return [file, module ? graph.dependencies(module, { runtimeOnly: true }).filter((f) => scanned.has(f)) : []];
    }));
    const defaults = new Map(files.map((file) => [file, modules.get(file) ? defaultTargets(modules.get(file)!, graph) : new Set<string>()]));
    const reached = new Map<string, { routes: Set<string>; via: string; shellOnly: boolean }>();
    // Screens first, so shared components name a screen as their attribution source.
    const ordered = [...entries].sort(([, a], [, b]) => Number(a.shell) - Number(b.shell));
    for (const [entryFile, entry] of ordered) {
      const stack = [{ file: entryFile, viaDefault: false }];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const { file, viaDefault } = stack.pop()!;
        // Importing a helper from another route does not render that route. Check
        // before marking visited: a later default re-export may still reach it.
        if (file !== entryFile && entries.has(file) && !viaDefault) continue;
        if (visited.has(file)) continue;
        visited.add(file);
        if (file !== entryFile) {
          const record = reached.get(file) ?? { routes: new Set<string>(), via: entryFile, shellOnly: true };
          for (const route of entry.routes) record.routes.add(route);
          if (!entry.shell) record.shellOnly = false;
          reached.set(file, record);
        }
        // Dependencies stay within the scan boundary, even when symbol resolution
        // later loads other files on demand.
        for (const dependency of dependencies.get(file) ?? []) {
          stack.push({ file: dependency, viaDefault: defaults.get(file)?.has(dependency) ?? false });
        }
      }
    }
    for (const [file, entry] of entries) {
      index.attribution.set(file, { routes: [...new Set([...entry.routes, ...(reached.get(file)?.routes ?? [])])].sort(), routeSource: entry.shell ? "shell" : "route-file" });
    }
    for (const [file, record] of reached) {
      if (index.attribution.has(file)) continue;
      index.attribution.set(file, { routes: [...record.routes].sort(), routeSource: record.shellOnly ? "shell" : "imported-by", via: record.via });
    }
    const importers = new Map<string, { runtime: string[]; typeOnly: string[] }>();
    for (const file of files) {
      const module = modules.get(file);
      if (!module) continue;
      const runtime = new Set(dependencies.get(file));
      for (const dependency of graph.dependencies(module)) {
        if (!scanned.has(dependency)) continue;
        const record = importers.get(dependency) ?? { runtime: [], typeOnly: [] };
        (runtime.has(dependency) ? record.runtime : record.typeOnly).push(file);
        importers.set(dependency, record);
      }
    }
    for (const file of files) {
      if (index.attribution.has(file)) continue;
      const incoming = importers.get(file);
      const reason = incoming?.runtime.length
        ? `Only files not on any screen import this file, including ${incoming.runtime[0]}.`
        : incoming?.typeOnly.length
          ? `Only type imports reach this file, including from ${incoming.typeOnly[0]}; they do not render it.`
          : "No scanned file imports this file.";
      const fix = file.endsWith(".css")
        ? "Import it from a route; for global styles, add it to routes.shell in youi.project.json."
        : "Import it from a route, or add it to routes.map or routes.shell in youi.project.json.";
      index.attribution.set(file, { routes: [], routeSource: "unrouted", routeReason: `${reason} ${fix}` });
    }
    return index;
  }

  of(file: string): RouteAttribution {
    return this.attribution.get(file) ?? { routes: [], routeSource: "unrouted", routeReason: this.unroutedReason };
  }
}
