/**
 * ui_find_component: before an agent writes UI, the project's own components that fit a need
 * ("dismissible alert", "primary button with icon"), best first, each with its import, props, a
 * real usage, where it is used and its library; or a plain "nothing fits" with where to start.
 *
 * A need is read with Discover's concepts (aliases.ts), so toast = snackbar and dialog = modal
 * come from one table. When the need names a concept, a component qualifies only if its name,
 * file name, role or a package it wraps names that concept; the other words only rank
 * (dismissible → onDismiss, icon → an icon at a site, primary → a variant value). Pure: the
 * caller reads the project, the System and the Discover index.
 */
import { posix } from "node:path";
import { systemStage, type ComponentContract, type ScanReport } from "@youiyoux/core";
import { libraryOfPackage, SHADCN_SLOTS } from "@youiyoux/detect";
import { conceptForRole, hasPhrase, normalize, readNeed, type Concept, type DiscoverHit } from "@youiyoux/discover";
import { importLine, type ComponentFacts, type ComponentProp, type ComponentSite, type Project, type ProjectComponents } from "@youiyoux/scanner";

/** Matches shown; the rest are counted. */
export const SHOWN_MATCHES = 3;
/** Below this a hit is a guess, and "nothing fits" is the honest answer. */
const THRESHOLD = 5;
const SITES_SHOWN = 4;

/** Words that ask for a way to close it, and the props that give one. */
const DISMISS_WORDS = new Set(["dismissible", "dismissable", "closable", "closeable", "dismiss", "close", "closing", "removable"]);
const DISMISS_PROP = /^(?:on(?:Dismiss|Close|Remove|OpenChange)|closable|dismissible|onClose\w*)$/i;
const ICON_WORDS = new Set(["icon", "icons", "glyph"]);
const ICON_PACKAGES = /^(?:lucide-react|@heroicons\/react|@radix-ui\/react-icons|react-icons|@phosphor-icons\/react|@tabler\/icons-react)$/;

export interface Candidate {
  readonly classKit?: boolean;
  readonly provider?: { name: string; sites: readonly ComponentSite[] };
  readonly lacks?: readonly string[];
  readonly name: string;
  readonly library: string;
  readonly importLine: string;
  /** The file to open: the component's own, or the System contract's vendored copy. */
  readonly file: string | null;
  readonly props: readonly ComponentProp[] | null;
  readonly sites: readonly ComponentSite[];
  /** System components: their contract name, for system_get_component. */
  readonly system?: { readonly id: string; readonly summary: string };
  readonly score: number;
  readonly why: readonly string[];
  /** Text a site that shows the match would contain (`onDismiss`, `"primary"`, `Icon`): the example prefers it. */
  readonly evidence: readonly string[];
}

export type FindResult =
  | { readonly kind: "matches"; readonly need: string; readonly concepts: readonly string[]; readonly matches: readonly Candidate[]; readonly looked: number }
  | { readonly kind: "none"; readonly need: string; readonly concepts: readonly Concept[]; readonly looked: number; readonly primitive: PrimitiveStart | null };

export interface PrimitiveStart {
  readonly package: string;
  readonly library: string | null;
  readonly exports: readonly string[];
  readonly at: string | null;
}

/** The System's components as candidates: contract, import line, stage and live sites from the scan. */
export interface SystemInput {
  readonly project: Project;
  readonly report: ScanReport | null;
}

/* ---------------------------------------------------------------- library */

/** shadcn (its data-slot names or components.json's ui folder; "shadcn (Radix)" when it wraps Radix), else its UI package's library, else hand-rolled. */
export function libraryOf(component: Pick<ComponentFacts, "ownSlots" | "ownPackages" | "definition">, project: Pick<ProjectComponents, "shadcnUi">): string {
  if (component.definition.kind === "class") return "class kit";
  const under = (dir: string | null): boolean => dir !== null && component.definition.file.startsWith(`${dir}/`);
  const kits = [...new Set(component.ownPackages.map(libraryOfPackage).filter((l) => l !== undefined && l.layer > 0).map((l) => l!.name))];
  if (component.ownSlots.some((s) => SHADCN_SLOTS.has(s)) || under(project.shadcnUi)) return kits.length ? `shadcn (${kits.map((k) => k.replace(/ Primitives$/, "")).join(", ")})` : "shadcn";
  return kits[0] ?? component.ownPackages.find((p) => !ICON_PACKAGES.test(p) && !/^(?:react|react-dom|clsx|class-variance-authority|tailwind-merge)$/.test(p)) ?? "hand-rolled";
}

/* ---------------------------------------------------------------- matching */

const ROLE_CONCEPT: Readonly<Record<string, string>> = { "link-as-button": "button", tabs: "tabs" };

/** The concept phrase a text names, if any of `concept`'s names occurs in it as whole words. */
function named(text: string, concept: Concept): string | null {
  const n = normalize(text);
  return concept.names.map(normalize).sort((a, b) => b.length - a.length).find((name) => hasPhrase(n, name)) ?? null;
}

/** "snackbar = toast" when the component goes by another of the concept's names than the need did. */
function alias(found: string, asked: string | null, concept: Concept): string {
  const want = asked ?? concept.names[0]!;
  return found === want ? `${found}` : `${found} = ${want}`;
}

interface Facts {
  readonly name: string;
  readonly file: string | null;
  readonly role: string | null;
  readonly packages: readonly string[];
  readonly props: readonly ComponentProp[] | null;
  readonly sites: readonly ComponentSite[];
  readonly classKit?: boolean;
}

/** Score one component against the need; null when it does not qualify. */
function score(facts: Facts, need: ReturnType<typeof readNeed>, asked: ReadonlyMap<string, string>): { score: number; why: string[]; evidence: string[] } | null {
  let total = 0;
  const why: string[] = [];
  const evidence: string[] = [];
  for (const concept of need.concepts) {
    const byName = named(facts.name, concept);
    const byFile = facts.file ? named(posix.basename(facts.file).replace(/\.[a-z]+$/, ""), concept) : null;
    const roleConcept = facts.role ? conceptForRole(ROLE_CONCEPT[facts.role] ?? facts.role) : undefined;
    const byPackage = facts.packages.find((p) => concept.packages.includes(p) || named(p.replace(/^@[^/]+\//, ""), concept) !== null);
    if (byName) {
      // A hook named for the concept (`useNotice`) is that concept's API, as exact as the name itself.
      total += normalize(facts.name).replace(/^use /, "") === byName ? 10 : 7;
      if (byName === asked.get(concept.id)) total += 1;
      why.push(`name ${facts.name}: ${alias(byName, asked.get(concept.id) ?? null, concept)}`);
    } else if (byFile) {
      total += 6;
      why.push(`file ${posix.basename(facts.file!)}: ${alias(byFile, asked.get(concept.id) ?? null, concept)}`);
    } else if (roleConcept?.id === concept.id) {
      total += 6;
      why.push(`plays the ${facts.role} role`);
    } else if (byPackage) {
      total += 5;
      why.push(`wraps ${byPackage} (${concept.names[0]})`);
    } else return null;
  }
  const propNames = (facts.props ?? []).map((p) => p.name);
  let wordHit = false;
  for (const word of need.words) {
    if (DISMISS_WORDS.has(word)) {
      const prop = propNames.find((p) => DISMISS_PROP.test(p));
      if (prop) {
        total += 4;
        why.push(`prop ${prop} (${word})`);
        evidence.push(prop);
      }
      continue;
    }
    if (ICON_WORDS.has(word)) {
      const prop = propNames.find((p) => /icon/i.test(p));
      const site = facts.sites.find((candidate) => /<[A-Z]\w*Icon\b|<Icon\b/.test(candidate.snippet));
      const renders = facts.packages.some((p) => ICON_PACKAGES.test(p));
      if (prop) why.push(`prop ${prop} (icon)`);
      else if (site) why.push(`used with an icon at ${s(site)}`);
      else if (renders) why.push("renders icons");
      if (prop || site || renders) {
        total += 3;
        evidence.push(prop ?? "Icon");
      }
      continue;
    }
    const value = (facts.props ?? []).find((p) => p.values?.some((v) => normalize(v) === word));
    if (value) {
      total += 3;
      why.push(`${value.name}="${value.values!.find((v) => normalize(v) === word)}"`);
      evidence.push(`"${value.values!.find((v) => normalize(v) === word)}"`);
      continue;
    }
    const prop = propNames.find((p) => hasPhrase(normalize(p), word));
    if (prop) {
      total += 2;
      why.push(`prop ${prop}`);
      evidence.push(prop);
      continue;
    }
    if (hasPhrase(normalize(facts.name), word) || (facts.file && hasPhrase(normalize(facts.file), word))) {
      total += need.concepts.length ? 3 : 6;
      wordHit = true;
      why.push(`name ${facts.name} (${word})`);
    }
  }
  // A need with no concept ("pricing hero") qualifies a component by its name only.
  if (need.concepts.length === 0 && !wordHit) return null;
  // Used components are proven in this codebase: a small lift that never outranks a match.
  total += Math.min(facts.sites.length, 4) * 0.25;
  return { score: total, why, evidence };
}

/** The concept phrase the need itself used, per concept (for "snackbar = toast"). */
function missingCapabilities(facts: Facts, need: ReturnType<typeof readNeed>): string[] {
  // Props not read statically are unknown, not missing.
  if (!facts.props && !facts.classKit) return [];
  const props = facts.props ?? [];
  const capabilities = facts.classKit
    ? [
        { words: DISMISS_WORDS, present: facts.sites.some((s) => /aria-label=["'](?:Dismiss|Close)|onClick=\{[^}]*(?:dismiss|close)/i.test(s.snippet)), missing: "dismiss control", edit: `a close <button type="button" aria-label="Dismiss"> inside the element that removes it, styled beside .${facts.name}` },
        { words: ICON_WORDS, present: true, missing: "", edit: "" },
      ]
    : [
        { words: DISMISS_WORDS, present: props.some((p) => DISMISS_PROP.test(p.name)), missing: "dismiss prop (onDismiss/onClose)", edit: "an optional onDismiss?: () => void that renders a close button calling it" },
        // children, asChild or an icon size all take an icon as content.
        { words: ICON_WORDS, present: props.some((p) => /icon|children|asChild/i.test(p.name) || p.values?.some((v) => /icon/i.test(v))) || facts.sites.some((s) => /<[A-Z]\w*Icon\b|<Icon\b/.test(s.snippet)) || facts.packages.some((p) => ICON_PACKAGES.test(p)), missing: "icon prop or child", edit: "an optional icon prop rendered beside the content" },
      ];
  return capabilities.filter((c) => need.words.some((w) => c.words.has(w)) && !c.present).map((c) => `${facts.name} has no ${c.missing}. To add one: ${c.edit}, in ${facts.file}.`);
}

function askedPhrases(need: string, concepts: readonly Concept[]): Map<string, string> {
  return new Map(concepts.flatMap((c) => {
    const phrase = named(need, c);
    return phrase ? [[c.id, phrase] as const] : [];
  }));
}

function systemCandidates(input: SystemInput, components: ProjectComponents): Array<{ facts: Facts; candidate: Omit<Candidate, "score" | "why" | "evidence"> }> {
  const { project, report } = input;
  return project.system.components.map(({ contract }) => {
    const vendored = posix.join(project.config.componentsDir, posix.basename(contract.source.file));
    const own = components.components.find((c) => c.definition.file === vendored && (c.definition.name === contract.source.export || c.export === contract.source.export));
    const sites = report ? report.usages.filter((u) => u.element === contract.id && u.kind === "render").map((u) => own?.sites.find((site) => site.file === u.file && site.line === u.line) ?? { file: u.file, line: u.line, column: u.column, routes: u.routes, props: {}, snippet: "" }) : (own?.sites ?? []);
    const props = contractProps(contract);
    const stage = report?.status === "complete" ? systemStage(sites.length) : null;
    return {
      facts: { name: contract.name, file: vendored, role: own?.definition.role ?? null, packages: own?.packages ?? [], props, sites },
      candidate: { name: contract.name, library: `System${stage ? `, ${stage}` : ""}`, importLine: importLine(project, contract), file: vendored, props, sites, system: { id: contract.id, summary: contract.summary } },
    };
  });
}

function contractProps(contract: ComponentContract): ComponentProp[] {
  return Object.entries(contract.props).map(([name, spec]) => (spec.type === "enum" ? { name, values: spec.values } : { name }));
}

/**
 * Rank the project's components (and the System's, first, when there is one) for a need.
 * System components shadow the vendored file they are built from.
 */
export function findComponents(need: string, components: ProjectComponents, system: SystemInput | null = null, limit = SHOWN_MATCHES): FindResult {
  const read = readNeed(need);
  const asked = askedPhrases(need, read.concepts);
  const fromSystem = system ? systemCandidates(system, components) : [];
  // A contract's vendored file and its parts (Card, CardHeader…) answer as the System component.
  const shadowed = new Set((system?.project.system.components ?? []).flatMap(({ contract }) => [contract.source.export, ...contract.source.also].map((name) => `${posix.join(system!.project.config.componentsDir, posix.basename(contract.source.file))}#${name}`)));
  const pool = [
    ...fromSystem.map((s) => ({ ...s, lift: 20 })),
    ...components.components
      .filter((c) => !shadowed.has(`${c.definition.file}#${c.definition.name}`))
      .map((c) => {
        // A component mounted once (a Toaster, a Provider) is used through its call API, when that
        // API is itself named for the need (`toast`, `useNotice`). A component rendered in several
        // places is the answer itself; a helper beside it (`cn`, `alertTone`) never stands in.
        const api = c.sites.length > 1 ? undefined : c.calls.find((a) => a.sites.length && (read.concepts.length
          ? read.concepts.every((concept) => named(a.name, concept))
          : read.words.some((word) => hasPhrase(normalize(a.name), word))));
        const classKit = c.definition.kind === "class";
        const name = api?.name ?? c.definition.name;
        const sites = api?.sites ?? c.sites;
        const line = api ? `import { ${api.name} } from "${api.from ?? c.specifier}";` : c.importLine;
        return {
          facts: { name: name.replace(/^\./, ""), file: c.definition.file, role: c.definition.role, packages: c.ownPackages, props: c.props, sites, classKit } satisfies Facts,
          candidate: { name, library: libraryOf(c, components), importLine: classKit ? c.definition.file : c.aliased || api?.from ? line : `${line} // from the project root: make it relative to your file`, file: c.definition.file, props: c.props, sites, classKit, ...(api ? { provider: { name: c.definition.name, sites: c.sites } } : {}) },
          lift: 0,
        };
      }),
  ];
  const scored = pool.flatMap(({ facts, candidate, lift }) => {
    const scored = score(facts, read, asked);
    return scored && scored.score >= THRESHOLD ? [{ ...candidate, score: scored.score + lift, why: scored.why, evidence: scored.evidence, lacks: missingCapabilities(facts, read) }] : [];
  });
  // A class kit is offered on its own usage. It is not when it only styles a component (`<Alert
  // className="notice">`), only lives inside a matching component's file (that component is the
  // thing to reuse), or is a part of a matching block (`.notice-title` beside `.notice`).
  const componentFiles = new Set(scored.filter((c) => !c.classKit && c.file).map((c) => c.file!));
  const kits = scored.filter((c) => c.classKit).map((c) => c.name);
  const ranked = scored
    .filter((c) => !c.classKit || !(
      kits.some((block) => block !== c.name && c.name.startsWith(`${block}-`)) ||
      (c.sites.length > 0 && c.sites.every((site) => /^<[A-Z]/.test(site.snippet) || componentFiles.has(site.file)))
    ))
    .sort((a, b) => b.score - a.score || Number(a.classKit ?? false) - Number(b.classKit ?? false) || b.sites.length - a.sites.length || a.name.localeCompare(b.name));
  if (ranked.length > 0) return { kind: "matches", need, concepts: read.concepts.map((c) => c.id), matches: ranked.slice(0, Math.max(1, limit)), looked: pool.length };
  return { kind: "none", need, concepts: read.concepts, looked: pool.length, primitive: primitiveFor(read, components) };
}

/** A library primitive the project already renders or imports that plays the concept (`@radix-ui/react-tooltip` for a tooltip). */
function primitiveFor(need: ReturnType<typeof readNeed>, components: ProjectComponents): PrimitiveStart | null {
  for (const concept of need.concepts) {
    for (const primitive of components.primitives) {
      if (ICON_PACKAGES.test(primitive.package)) continue;
      const usable = primitive.exports.filter((e) => !/Icon$/.test(e));
      if (!usable.length) continue;
      const exports = usable.filter((e) => named(e, concept) !== null);
      if (!concept.packages.includes(primitive.package) && named(primitive.package.replace(/^@[^/]+\//, ""), concept) === null && exports.length === 0) continue;
      const site = primitive.sites[0];
      const library = libraryOfPackage(primitive.package);
      return { package: primitive.package, library: library?.name ?? null, exports: exports.length ? exports : usable, at: site ? `${site.file}:${site.line}` : null };
    }
  }
  return null;
}

/* ---------------------------------------------------------------- text */

const s = (site: Pick<ComponentSite, "file" | "line">): string => `${site.file}:${site.line}`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function propsLine(props: readonly ComponentProp[] | null, file: string | null): string {
  if (!props) return `Props: not read statically; open ${file ?? "its file"}`;
  const text = props.map((p) => (p.values ? `${p.name}: ${p.values.join("|")}` : p.name));
  return `Props: ${text.slice(0, 10).join(", ")}${text.length > 10 ? `, … (+${text.length - 10} more)` : ""}`;
}

function usedLine(sites: readonly ComponentSite[]): string {
  if (sites.length === 0) return "Used in 0 places yet";
  const routes = [...new Set(sites.flatMap((site) => site.routes))];
  const shown = sites.slice(0, SITES_SHOWN).map((site) => `${s(site)}${site.routes.length ? ` (${site.routes.join(", ")})` : ""}`);
  return `Used in ${plural(sites.length, "place")}${routes.length ? ` on ${plural(routes.length, "route")}` : ""}: ${shown.join(", ")}${sites.length > SITES_SHOWN ? `, … (+${sites.length - SITES_SHOWN} more)` : ""}`;
}

function matchText(match: Candidate, index: number): string[] {
  // The first site that shows what matched (onDismiss, variant="primary"), else the first with a snippet.
  // A call API's example is a call written the way the import line names it (`toast.success(…)`, not an alias).
  const shown = (site: ComponentSite): number => match.evidence.filter((e) => site.snippet.includes(e)).length;
  const direct = (site: ComponentSite): number => Number(Boolean(match.provider) && (site.snippet.startsWith(`${match.name}(`) || site.snippet.startsWith(`${match.name}.`)));
  const example = [...match.sites].filter((site) => site.snippet).sort((a, b) => shown(b) - shown(a) || direct(b) - direct(a))[0];
  return [
    match.classKit
      ? `${index + 1}. Use ${match.name} class kit (class kit, ${match.file}): ${example?.snippet.match(/class(?:Name)?=["'][^"']*["']/)?.[0] ?? `className="${match.name.replace(/^\./, "")}"`}`
      : `${index + 1}. Use ${match.name} (${match.library}): ${match.importLine}`,
    ...(match.provider ? [match.provider.sites.length ? `   <${match.provider.name}/> is already mounted at ${match.provider.sites.map(s).join(", ")}; don't mount another.` : `   No <${match.provider.name}/> mount was found; check ${match.file} for setup before calling ${match.name}().`] : []),
    ...(match.lacks ?? []).map((lack) => `   Lacks: ${lack}`),
    ...(match.system ? [`   ${match.system.summary}`] : []),
    `   Why: ${match.why.join("; ")}`,
    `   ${match.provider ? `${match.provider.name} provider ` : ""}${propsLine(match.props, match.file)}`,
    ...(example ? [`   Example at ${s(example)}:`, ...example.snippet.split("\n").map((l) => `     ${l}`)] : []),
    `   ${usedLine(match.sites)}`,
  ];
}

/** The answer when something fits: best first, then what to do next. */
export function matchesText(result: Extract<FindResult, { kind: "matches" }>, inSystem: boolean): string {
  const count = result.matches.length;
  const [best] = result.matches;
  const next = best!.classKit
    ? `Next: apply the ${best!.name} classes from ${best!.file}, following the real usage shown.`
    : best!.provider
    ? `Next: import ${best!.name} as shown and call it like the example; ${best!.provider.sites.length ? "reuse the mounted provider" : `check ${best!.file} for provider setup`}${inSystem ? ", then run system_check on your code" : ""}.`
    : best!.system
    ? `Next: import it as shown, check its props with system_get_component {"name": "${best!.name}"} and use only the listed values, then run system_check on your code before finishing.`
    : `Next: import ${best!.name} as shown and reuse it instead of writing a new component; open ${best!.file} to confirm its props before using them${inSystem ? ", and run system_check on your code before finishing" : ""}.`;
  return [
    `${plural(count, "existing component")} in this project ${count === 1 ? "fits" : "fit"} "${result.need}" (${count === 1 ? "" : "best first; "}looked at ${result.looked}):`,
    ...result.matches.flatMap(matchText),
    next + (best!.lacks?.length ? ` First add the missing capability in ${best!.file} as described above.` : ""),
  ].join("\n");
}

export interface NoneFitsInput {
  readonly result: Extract<FindResult, { kind: "none" }>;
  /** Discover candidates for the need, or null when there is no local index. */
  readonly discover: readonly DiscoverHit[] | null;
  readonly componentsDir: string | null;
  readonly inSystem: boolean;
}

/** The answer when nothing fits: say so plainly, then where to start. */
export function noneFitsText({ result, discover, componentsDir, inSystem }: NoneFitsInput): string {
  discover = discover?.filter((hit) => !ICON_PACKAGES.test(hit.name) && !/Icon$/.test(hit.name) && !hit.why.includes("icon set") && !/(?:^|[\s/_-])icons?(?:$|[\s/_-])/i.test(`${hit.name} ${hit.source.name}`) && !/lucide|heroicons|react-icons|phosphor|tabler.*icons|radix.*icons/i.test(hit.source.ref ?? hit.id)) ?? null;
  const where = componentsDir ? `in ${componentsDir}/` : "beside the project's other components";
  const lines = [`Nothing in this project fits "${result.need}" (looked at ${plural(result.looked, "component")}${result.concepts.length ? ` by name, file, role and props, as ${result.concepts.map((c) => c.names.slice(0, 3).join(" = ")).join("; ")}` : " by name"}).`];
  if (result.primitive) {
    const p = result.primitive;
    lines.push(`Start from: ${p.package}${p.library ? ` (${p.library})` : ""}, which this project already uses${p.at ? ` at ${p.at}` : ""}; parts: ${p.exports.slice(0, 6).join(", ")}.`);
    lines.push(inSystem ? `Next: build it from that primitive ${where} and propose it to the System with library_request, or ask a person; then call ui_find_component again before using it.` : `Next: build it from that primitive as a new component ${where}, so the next agent finds it with ui_find_component.`);
    return lines.join("\n");
  }
  if (discover && discover.length > 0) {
    lines.push("Start from one of these Discover candidates (outside references, not installed here):");
    for (const hit of discover.slice(0, 3)) lines.push(`- ${hit.source.ref ?? hit.id} (${hit.id}): ${hit.title ?? hit.name}, licence ${hit.license}${hit.signals.weeklyDownloads !== null ? `, ${hit.signals.weeklyDownloads.toLocaleString("en-US")}/week` : ""}${hit.install ? `; install: ${hit.install.command}` : ""}`);
    lines.push(inSystem ? `Next: propose the best one with library_request {"item": "<lib: id>", "reason": "…"} for a person to approve; don't install or copy it yourself.` : `Next: show these to a person and install only the one they choose (licence first), then build it ${where}; discover_show <id> has the details.`);
    return lines.join("\n");
  }
  lines.push(discover === null ? `No Discover index on this machine to suggest a starting point: run youi discover sync, then youi discover "${result.need}".` : `Discover has no candidate for "${result.need}" either; try other words, or youi discover "${result.need}" --all.`);
  lines.push(inSystem ? `Next: draft it with library_request or ask a person before adding a component outside the System.` : `Next: build it as a new component ${where}, so the next agent finds it with ui_find_component.`);
  return lines.join("\n");
}
