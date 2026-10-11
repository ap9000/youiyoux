/**
 * The shapes the hub reads.
 *
 * Contract, rule and usage types mirror @youiyoux/core (packages/core/src/schemas.ts),
 * which validates every snapshot when `pnpm data` writes it. This thin, type-only
 * adapter stands in until apps/web joins the root workspace and can import them;
 * keep field names identical so that switch is a one-line import change.
 */

export type ElementKind = "token" | "component" | "rule" | "migration";
export type ElementId = string;

interface PropBase {
  description?: string;
  required?: boolean;
  deprecated?: string;
}

export type PropSpec =
  | (PropBase & { type: "enum"; values: string[]; default?: string })
  | (PropBase & { type: "string"; default?: string })
  | (PropBase & { type: "boolean"; default?: boolean })
  | (PropBase & { type: "number"; default?: number })
  | (PropBase & { type: "function" })
  | (PropBase & { type: "node" });

export type ComponentStatus = "draft" | "beta" | "stable" | "deprecated";

export interface ComponentContract {
  schema: "youi.component/v1";
  id: ElementId;
  name: string;
  version: string;
  status: ComponentStatus;
  summary: string;
  source: { file: string; export: string; also: string[] };
  platforms: Array<"web" | "ios" | "android">;
  props: Record<string, PropSpec>;
  passthrough?: string;
  tokens: Record<string, ElementId>;
  a11y: { role?: string; minTouchTarget?: number; notes: string[] };
  rules: ElementId[];
  guidance: { do: string[]; dont: string[] };
  examples: Array<{ title: string; code: string }>;
  aliases: string[];
  owners: string[];
  deprecation?: { replacement?: ElementId; removeIn?: string; note: string };
}

export type RuleSeverity = "error" | "warn" | "off";

export type RuleCheck =
  | { engine: "youi"; id: string; options: Record<string, unknown> }
  | { engine: "ast-grep"; language: string; rule: Record<string, unknown> }
  | { engine: "advisory" };

export interface RuleSpec {
  schema: "youi.rule/v1";
  id: ElementId;
  title: string;
  severity: RuleSeverity;
  statement: string;
  rationale: string;
  agent: string;
  check: RuleCheck;
  files: string[];
  examples: { bad: string[]; good: string[] };
}

export type PropValue = { literal: string | number | boolean } | { dynamic: string };

interface Position {
  file: string;
  line: number;
  column: number;
}

export type RouteSource = "route-file" | "imported-by" | "shell" | "unrouted";

export interface UsageSite extends Position {
  element: ElementId;
  kind: "render" | "variants" | "reference";
  /** The canonical export used: the element itself, a sub-part (CardHeader) or its variants function. */
  export: string;
  local: string;
  props: Record<string, PropValue>;
  spread: boolean;
  routes: string[];
  routeSource: RouteSource;
  via?: string;
  fingerprint: string;
}

export interface UnknownSite extends Position {
  name: string;
  reason: string;
  detail: string;
  candidate?: ElementId;
}

export interface Lookalike extends Position {
  resembles: ElementId;
  local: string;
  resolved: string;
}

export interface Violation extends Position {
  rule: ElementId;
  severity: "error" | "warn";
  message: string;
  text: string;
  suggestion?: string;
}

export interface ScanReport {
  schema: "youi.usage/v1";
  project: string;
  system: string;
  commit: string | null;
  scanner: string;
  configDigest: string;
  generatedAt: string;
  durationMs: number;
  status: "complete" | "partial";
  coverage: { filesMatched: number; filesScanned: number; failed: Array<{ file: string; reason: string }> };
  usages: UsageSite[];
  unknowns: UnknownSite[];
  suppressed: number;
  lookalikes: Lookalike[];
  violations: Violation[];
}

/* ------------------------------------------------- hub snapshots (scripts/snapshot.ts) */

export interface TokenEntry {
  id: ElementId;
  /** DTCG path, e.g. `color.ink`. */
  path: string;
  group: string;
  type: string;
  cssVar: string;
  /** Resolved CSS value per scheme. */
  light: string;
  dark: string;
  /** Structured value for typography tokens (font size, weight, line height). */
  lightValue?: unknown;
  /** [this token, …, the token that holds the value]. Length 1 when not an alias. */
  aliasChain: ElementId[];
  description?: string;
}

export interface ComponentEntry {
  contract: ComponentContract;
  /** The owned files a project vendors: the component source plus the system's support files. */
  files: Array<{ path: string; code: string }>;
}

export interface SystemInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  cssPrefix: string;
  /** Narrative Markdown (principles, named rules). */
  design: string;
}

export interface Catalog {
  schema: "youiyoux.catalog/v1";
  system: SystemInfo;
  tokens: TokenEntry[];
  components: ComponentEntry[];
  rules: RuleSpec[];
}

export interface Manifest {
  schema: "youiyoux.manifest/v1";
  source: { commit: string | null };
  systems: Array<{ id: string; catalog: string; usage: Array<{ project: string; file: string }> }>;
}
