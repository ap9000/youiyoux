/** The in-memory catalog model: one ordered element list plus the lookups every screen needs. */
import { parseId } from "./ids.ts";
import type { Catalog, ComponentEntry, ComponentStatus, ElementId, ElementKind, Manifest, RuleSeverity, RuleSpec, TokenEntry } from "./types.ts";

export interface ElementSummary {
  readonly id: ElementId;
  readonly kind: ElementKind;
  /** Display name: `Button`, `color.ink`, `No raw colours`. */
  readonly name: string;
  /** Mono secondary key: export name, css variable or rule id tail. */
  readonly key: string;
  readonly summary: string;
  readonly group: string;
  readonly status?: ComponentStatus;
  readonly severity?: RuleSeverity;
  readonly tokenType?: string;
  /** Light and dark colour for a swatch, when the element is a colour token. */
  readonly swatch?: { light: string; dark: string };
}

export interface TokenConsumer {
  readonly component: ElementId;
  readonly role: string;
}

export interface Model {
  readonly manifest: Manifest;
  readonly catalog: Catalog;
  readonly elements: readonly ElementSummary[];
  readonly byId: ReadonlyMap<ElementId, ElementSummary>;
  readonly tokens: ReadonlyMap<ElementId, TokenEntry>;
  readonly tokenByPath: ReadonlyMap<string, TokenEntry>;
  readonly components: ReadonlyMap<ElementId, ComponentEntry>;
  readonly rules: ReadonlyMap<ElementId, RuleSpec>;
  /** Token id → the components whose contracts bind it, and under which role. */
  readonly tokenConsumers: ReadonlyMap<ElementId, readonly TokenConsumer[]>;
  /** Rule id → the components that declare it. */
  readonly ruleComponents: ReadonlyMap<ElementId, readonly ElementId[]>;
}

export const KIND_ORDER: readonly ElementKind[] = ["component", "token", "rule", "migration"];
export const TOKEN_GROUP_ORDER = ["color", "typography", "space", "radius", "shadow", "font", "easing"];

const groupRank = (group: string): number => {
  const index = TOKEN_GROUP_ORDER.indexOf(group);
  return index === -1 ? TOKEN_GROUP_ORDER.length : index;
};

function componentSummary({ contract }: ComponentEntry): ElementSummary {
  return { id: contract.id, kind: "component", name: contract.name, key: contract.source.export, summary: contract.summary, group: "component", status: contract.status };
}

function tokenSummary(token: TokenEntry): ElementSummary {
  return {
    id: token.id,
    kind: "token",
    name: token.path,
    key: token.cssVar,
    summary: token.description ?? "",
    group: token.group,
    tokenType: token.type,
    ...(token.type === "color" ? { swatch: { light: token.light, dark: token.dark } } : {}),
  };
}

function ruleSummary(rule: RuleSpec): ElementSummary {
  return { id: rule.id, kind: "rule", name: rule.title, key: parseId(rule.id)?.name ?? rule.id, summary: rule.statement, group: "rule", severity: rule.severity };
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildModel(catalog: Catalog, manifest: Manifest): Model {
  const components = [...catalog.components].sort((a, b) => a.contract.name.localeCompare(b.contract.name));
  const tokens = [...catalog.tokens].sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.path.localeCompare(b.path));
  const rules = [...catalog.rules].sort((a, b) => a.title.localeCompare(b.title));
  const elements = [...components.map(componentSummary), ...tokens.map(tokenSummary), ...rules.map(ruleSummary)];

  const tokenConsumers = new Map<ElementId, TokenConsumer[]>();
  const ruleComponents = new Map<ElementId, ElementId[]>();
  for (const { contract } of components) {
    for (const [role, token] of Object.entries(contract.tokens)) append(tokenConsumers, token, { component: contract.id, role });
    for (const rule of contract.rules) append(ruleComponents, rule, contract.id);
  }

  return {
    manifest,
    catalog,
    elements,
    byId: new Map(elements.map((e) => [e.id, e])),
    tokens: new Map(tokens.map((t) => [t.id, t])),
    tokenByPath: new Map(tokens.map((t) => [t.path, t])),
    components: new Map(components.map((c) => [c.contract.id, c])),
    rules: new Map(rules.map((r) => [r.id, r])),
    tokenConsumers,
    ruleComponents,
  };
}

export function countByKind(elements: readonly ElementSummary[]): Record<ElementKind, number> {
  const counts: Record<ElementKind, number> = { component: 0, token: 0, rule: 0, migration: 0 };
  for (const element of elements) counts[element.kind]++;
  return counts;
}
