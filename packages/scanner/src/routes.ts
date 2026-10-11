/**
 * Route attribution. A site's screen is known when its file is a route
 * (expo-router file path, or an explicit map entry with evidence) or when a
 * route file reaches it through imports; otherwise it is `unrouted`, which a
 * reader sees, rather than a guess.
 */
import { matchesAny, type RouteConfig, type UsageSite } from "@youiyoux/core";
import type { ModuleGraph } from "./graph.ts";
import type { ModuleInfo } from "./parse.ts";

export type RouteAttribution = Pick<UsageSite, "routes" | "routeSource" | "via">;

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
      const routes = config.map.filter((m) => matchesAny(file, [m.file])).flatMap((m) => m.routes);
      if (routes.length > 0) entries.set(file, { routes: [...new Set(routes)], shell: false });
    }
  }
  return entries;
}

export class RouteIndex {
  private readonly attribution = new Map<string, RouteAttribution>();

  static build(graph: ModuleGraph, modules: ReadonlyMap<string, ModuleInfo | null>, config: RouteConfig): RouteIndex {
    const index = new RouteIndex();
    if (config.strategy === "none" && config.shell.length === 0) return index;
    const files = [...modules.keys()];
    const scanned = new Set(files);
    const entries = routeEntries(files, config);
    const reached = new Map<string, { routes: Set<string>; via: string; shellOnly: boolean }>();
    // Screens first, so a component a screen imports is attributed to that screen; shells
    // do not traverse into route files (an app shell imports every screen).
    const ordered = [...entries].sort(([, a], [, b]) => Number(a.shell) - Number(b.shell));
    for (const [entryFile, entry] of ordered) {
      const stack = [entryFile];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const file = stack.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        if (file !== entryFile && entries.has(file) && !entries.get(file)!.shell) continue;
        if (file !== entryFile) {
          const record = reached.get(file) ?? { routes: new Set<string>(), via: entryFile, shellOnly: true };
          for (const route of entry.routes) record.routes.add(route);
          if (!entry.shell) record.shellOnly = false;
          reached.set(file, record);
        }
        // Stay inside the scanned set: screens are made of scanned files, and walking into the
        // rest of the codebase (server modules a view imports types from) costs parses, not facts.
        const module = scanned.has(file) ? modules.get(file) : null;
        if (module) stack.push(...graph.dependencies(module));
      }
    }
    for (const [file, entry] of entries) {
      index.attribution.set(file, { routes: [...entry.routes], routeSource: entry.shell ? "shell" : "route-file" });
    }
    for (const [file, record] of reached) {
      if (index.attribution.has(file)) continue;
      index.attribution.set(file, { routes: [...record.routes].sort(), routeSource: record.shellOnly ? "shell" : "imported-by", via: record.via });
    }
    return index;
  }

  of(file: string): RouteAttribution {
    return this.attribution.get(file) ?? { routes: [], routeSource: "unrouted" };
  }
}
