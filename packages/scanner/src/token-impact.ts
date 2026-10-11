/**
 * What a token change reaches, for `youi plan --token`: every token whose value reads it
 * (aliases, multi-hop and partial, in either scheme), the contracts that bind any of them or
 * whose owned implementation uses them, and every direct use in project code: the CSS
 * variable, the Tailwind theme variable and the Tailwind utilities generated for it.
 *
 * The result is a lower bound. Class names built at runtime and uses outside the scanned
 * files are invisible to it, so "no use found" is never proof of no effect.
 */
import { matchesAny } from "@youiyoux/core";
import type { ResolvedToken } from "@youiyoux/tokens";
import { vendoredPath } from "./elements.ts";
import type { Project } from "./project.ts";
import type { ScanResult } from "./scan.ts";

const COLOR_UTILITIES = ["bg", "text", "border", "border-x", "border-y", "border-t", "border-r", "border-b", "border-l", "border-s", "border-e", "ring", "ring-offset", "inset-ring", "outline", "fill", "stroke", "divide", "decoration", "caret", "accent", "from", "via", "to", "placeholder", "shadow", "inset-shadow"];
const RADIUS_UTILITIES = ["rounded", ...["t", "r", "b", "l", "tl", "tr", "br", "bl", "s", "e", "ss", "se", "es", "ee"].map((side) => `rounded-${side}`)];
const SPACING_UTILITIES = ["p", "px", "py", "pt", "pr", "pb", "pl", "ps", "pe", "m", "mx", "my", "mt", "mr", "mb", "ml", "ms", "me", "gap", "gap-x", "gap-y", "space-x", "space-y", "w", "h", "size", "min-w", "min-h", "max-w", "max-h", "inset", "inset-x", "inset-y", "top", "right", "bottom", "left", "start", "end", "basis", "indent", "scroll-m", "scroll-p", "translate-x", "translate-y"];

/** Tailwind v4 theme namespace → the utilities that read it. Multi-word namespaces come first. */
const UTILITIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["font-weight", ["font"]],
  ["inset-shadow", ["inset-shadow"]],
  ["drop-shadow", ["drop-shadow"]],
  ["text-shadow", ["text-shadow"]],
  ["color", COLOR_UTILITIES],
  ["radius", RADIUS_UTILITIES],
  ["spacing", SPACING_UTILITIES],
  ["text", ["text"]],
  ["font", ["font"]],
  ["shadow", ["shadow"]],
  ["ease", ["ease"]],
  ["tracking", ["tracking"]],
  ["leading", ["leading"]],
];

const MAX_SITES = 10;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every token whose value changes with `tokenId`, itself included: dependencies followed backwards to a fixed point. */
export function tokenClosure(tokens: readonly ResolvedToken[], tokenId: string): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const token of tokens) {
    for (const dep of token.dependsOn ?? (token.aliasOf ? [token.aliasOf] : [])) dependents.set(dep, [...(dependents.get(dep) ?? []), token.id]);
  }
  const reached = new Set([tokenId]);
  const queue = [tokenId];
  while (queue.length > 0) {
    for (const next of dependents.get(queue.shift()!) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}

/** The names that use a token: its CSS variable, its Tailwind theme variables and their utilities. */
function useNames(token: ResolvedToken, prefix: string, themeKeys: readonly string[]): string[] {
  const variables = [`--${prefix}-${token.cssName}`, ...themeKeys.map((key) => `--${key}`)];
  const utilities = themeKeys
    .filter((key) => !key.includes("--"))
    .flatMap((key) => {
      const [namespace, users] = UTILITIES.find(([ns]) => key.startsWith(`${ns}-`)) ?? [key.split("-")[0]!, [key.split("-")[0]!]];
      const name = key.slice(namespace.length + 1);
      return users.map((utility) => `${utility}-${name}`);
    });
  return [...variables, ...utilities];
}

export interface DirectUse {
  readonly file: string;
  readonly uses: number;
  readonly line: number;
  readonly text: string;
}

export interface TokenImpact {
  /** Tokens whose value changes with this one (aliases and composites that read it), excluding itself. */
  readonly dependents: readonly string[];
  readonly contracts: ReadonlyArray<{ readonly id: string; readonly name: string; readonly via: "binding" | "implementation" }>;
  /** Uses in project code outside the owned implementations of those contracts. */
  readonly direct: { readonly uses: number; readonly files: number; readonly sites: readonly DirectUse[] };
  /** A stylesheet, the app shell, or a file no screen is known to import uses it: every screen is a visual target. */
  readonly everyScreen: boolean;
  /** Routes reached by direct uses, with their use counts. */
  readonly directRoutes: ReadonlyMap<string, number>;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function bindingContracts(project: Project, affected: ReadonlySet<string>): Map<string, "binding" | "implementation"> {
  const contracts = new Map<string, "binding" | "implementation">();
  for (const { contract } of project.system.components) {
    if (Object.values(contract.tokens).some((id) => affected.has(id.replace(/^youi:[a-z-]+\/token\//, "")))) contracts.set(contract.id, "binding");
  }
  return contracts;
}

export function tokenImpact(project: Project, scan: ScanResult, tokenId: string): TokenImpact {
  const affected = tokenClosure(scan.tokens.tokens, tokenId);
  const names = scan.tokens.tokens.filter((t) => affected.has(t.id)).flatMap((t) => useNames(t, scan.tokens.prefix, scan.tokens.themeKeys.get(t.id) ?? []));
  // `-?` admits negative utilities (-mt-4); `.` after a name means a different scale step (p-1 vs p-1.5).
  const pattern = new RegExp(`(?<![\\w-])-?(?:${[...new Set(names)].map(escape).join("|")})(?![\\w.-])`, "g");
  const implementedBy = new Map<string, string[]>();
  for (const { contract } of project.system.components) {
    const file = vendoredPath(project, contract.source.file);
    implementedBy.set(file, [...(implementedBy.get(file) ?? []), contract.id]);
  }

  const contracts = bindingContracts(project, affected);
  const sites: DirectUse[] = [];
  const directRoutes = new Map<string, number>();
  let everyScreen = false;
  for (const module of scan.modules.values()) {
    // Definitions, not uses: the generated outputs and the project's own token sources.
    if (module.file.startsWith(`${project.config.outputs.dir}/`) || matchesAny(module.file, project.config.tokenSources)) continue;
    const matches = [...module.source.matchAll(pattern)];
    if (matches.length === 0) continue;
    const implemented = implementedBy.get(module.file);
    if (implemented) {
      for (const id of implemented) if (!contracts.has(id)) contracts.set(id, "implementation");
      continue;
    }
    const first = matches[0]!;
    sites.push({ file: module.file, uses: matches.length, line: lineOf(module.source, first.index), text: first[0] });
    const { routes, routeSource } = scan.routes.of(module.file);
    if (routeSource === "unrouted" || routeSource === "shell") everyScreen = true;
    for (const route of routes) directRoutes.set(route, (directRoutes.get(route) ?? 0) + matches.length);
  }
  const name = (id: string): string => project.system.components.find((c) => c.contract.id === id)?.contract.name ?? id;
  return {
    dependents: [...affected].filter((id) => id !== tokenId).sort(),
    contracts: [...contracts].map(([id, via]) => ({ id, name: name(id), via })),
    direct: { uses: sites.reduce((n, s) => n + s.uses, 0), files: sites.length, sites: sites.sort((a, b) => b.uses - a.uses || a.file.localeCompare(b.file)).slice(0, MAX_SITES) },
    everyScreen,
    directRoutes,
  };
}
