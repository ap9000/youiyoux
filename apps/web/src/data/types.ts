/**
 * The shapes the hub reads. Design-language formats (contracts, rules, usage maps) are
 * @youiyoux/core's own types, imported type-only so no validation code ships to the
 * browser: `pnpm data` validates every snapshot with core's schemas when it writes them.
 * The hub's snapshot shapes follow.
 */
import type { ComponentContract, ElementId, RuleSpec, UsageSite } from "@youiyoux/core";

export type {
  ComponentContract,
  ElementId,
  ElementKind,
  Lookalike,
  PropSpec,
  PropValue,
  RuleSpec,
  ScanReport,
  UnknownSite,
  UsageSite,
  Violation,
} from "@youiyoux/core";

export type ComponentStatus = ComponentContract["status"];
export type RuleSeverity = RuleSpec["severity"];
export type RuleCheck = RuleSpec["check"];
export type RouteSource = UsageSite["routeSource"];

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
