/**
 * The design language's file formats. Every schema here is the single source
 * for both runtime validation and the published JSON Schema (`schema/*.json`).
 */
import { z } from "zod";
import { ElementId } from "./ids.ts";

const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "expected semver x.y.z");
const RelPath = z.string().min(1).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "expected a path relative to its root, without ..");
const IsoTime = z.string().datetime({ offset: true });

/* ---------------------------------------------------------------- youi.config/v1 */

export const SystemConfig = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  version: SemVer,
  description: z.string().default(""),
  /** DTCG 2025.10 resolver document for this system's tokens. */
  tokens: RelPath,
  /** Modifier in the resolver that switches colour scheme, and its contexts. */
  themeModifier: z.object({ name: z.string(), light: z.string(), dark: z.string() }).optional(),
  /** Directory holding `<name>/<name>.contract.json` component folders. */
  components: RelPath.default("components"),
  /** Files every vendored component needs (e.g. the `cn` helper), relative to the components dir. */
  support: z.array(RelPath).default([]),
  rules: RelPath.default("rules"),
  /** Narrative Markdown for DESIGN.md (principles, named rules); tokens are generated. */
  design: RelPath.optional(),
});
export type SystemConfig = z.infer<typeof SystemConfig>;

export const DesignConfig = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.config/v1"),
  name: z.string().min(1),
  systems: z.array(SystemConfig).min(1),
});
export type DesignConfig = z.infer<typeof DesignConfig>;

/* --------------------------------------------------------------- youi.project/v1 */

export const RouteMapEntry = z.object({
  /** Glob (or exact path) of the files that render this route's screen. */
  file: z.string().min(1),
  routes: z.array(z.string().min(1)).min(1),
  /** Where this mapping came from, so a reader can check it. */
  evidence: z.string().optional(),
});

export const RouteConfig = z.object({
  /** `expo-router`: file paths under appDir are routes. `map`: explicit file → route entries. */
  strategy: z.enum(["expo-router", "map", "none"]).default("none"),
  appDir: RelPath.default("app"),
  map: z.array(RouteMapEntry).default([]),
  /** Files that wrap every route (an app shell); their sites are attributed to `*`. */
  shell: z.array(z.string()).default([]),
});
export type RouteConfig = z.infer<typeof RouteConfig>;

export const DarkSelector = z.object({ media: z.string().optional(), selector: z.string().min(1) });

export const DEFAULT_DARK_SELECTORS = [
  { media: "(prefers-color-scheme: dark)", selector: ":root:not([data-theme=\"light\"])" },
  { selector: ":root[data-theme=\"dark\"]" },
];

export const TailwindConfig = z.object({
  /** Emit a Tailwind name for every token (`--color-ink`, `--radius-md`, …). */
  includeAll: z.boolean().default(true),
  /** Tailwind theme variable (without `--`) → token id or literal; wins over includeAll names. */
  map: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string()).default({}),
});

export const OutputConfig = z.object({
  /** Where generated token files go, relative to the project root. */
  dir: RelPath.default("src/design"),
  /** CSS custom property prefix: `--<prefix>-<name>`. */
  cssVarPrefix: z.string().regex(/^[a-z][a-z0-9-]*$/).default("youi"),
  /** Where the dark values apply: each entry is a selector, optionally inside a media query. */
  dark: z.array(DarkSelector).default(DEFAULT_DARK_SELECTORS),
  targets: z.array(z.enum(["css-vars", "tailwind-v4", "ts", "react-native"])).default(["css-vars", "tailwind-v4", "ts"]),
  tailwind: TailwindConfig.default({ includeAll: true, map: {} }),
});
export type OutputConfig = z.infer<typeof OutputConfig>;

export const AgentConfig = z.object({
  agentsMd: RelPath.default("AGENTS.md"),
  designMd: RelPath.default("DESIGN.md"),
  skillDir: RelPath.default(".agents/skills/design-language"),
  /** Also expose the skill at `.claude/skills/design-language` (a symlink). */
  claudeSkillLink: z.boolean().default(true),
});

export const ProjectConfig = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.project/v1"),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  system: z.string(),
  /** Path to the design-language definitions repo, relative to the project root or absolute. */
  source: z.object({ path: z.string().min(1) }),
  tsconfig: RelPath.default("tsconfig.json"),
  include: z.array(z.string()).min(1),
  exclude: z.array(z.string()).default([]),
  /** Where owned (vendored) components live; their files are the canonical implementations. */
  componentsDir: RelPath,
  /** Files allowed to define raw colour values (the token source of truth or its generated copy). */
  tokenSources: z.array(z.string()).default([]),
  routes: RouteConfig.default({ strategy: "none", appDir: "app", map: [], shell: [] }),
  outputs: OutputConfig.default({ dir: "src/design", cssVarPrefix: "youi", dark: DEFAULT_DARK_SELECTORS, targets: ["css-vars", "tailwind-v4", "ts"], tailwind: { includeAll: true, map: {} } }),
  agents: AgentConfig.default({ agentsMd: "AGENTS.md", designMd: "DESIGN.md", skillDir: ".agents/skills/design-language", claudeSkillLink: true }),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/* ------------------------------------------------------------- youi.component/v1 */

const PropBase = { description: z.string().optional(), required: z.boolean().default(false), deprecated: z.string().optional() };

export const PropSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enum"), values: z.array(z.string()).min(1), default: z.string().optional(), ...PropBase }),
  z.object({ type: z.literal("string"), default: z.string().optional(), ...PropBase }),
  z.object({ type: z.literal("boolean"), default: z.boolean().optional(), ...PropBase }),
  z.object({ type: z.literal("number"), default: z.number().optional(), ...PropBase }),
  z.object({ type: z.literal("function"), ...PropBase }),
  z.object({ type: z.literal("node"), ...PropBase }),
]);
export type PropSpec = z.infer<typeof PropSpec>;

export const ComponentContract = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.component/v1"),
  id: ElementId,
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "expected the exported component name, PascalCase"),
  version: SemVer,
  status: z.enum(["draft", "beta", "stable", "deprecated"]),
  summary: z.string().min(1).max(200),
  /**
   * The owned implementation, vendored into each project's componentsDir. `file` is relative to
   * the system's components dir; several contracts may share one file (e.g. form controls).
   * `also` lists sub-part exports that belong to this element (CardHeader, TabsTrigger, …).
   */
  source: z.object({ file: RelPath, export: z.string().min(1), also: z.array(z.string()).default([]) }),
  platforms: z.array(z.enum(["web", "ios", "android"])).min(1),
  props: z.record(z.string(), PropSpec),
  /** Native element whose remaining props pass through (e.g. "button"). */
  passthrough: z.string().optional(),
  tokens: z.record(z.string(), ElementId).default({}),
  a11y: z.object({ role: z.string().optional(), minTouchTarget: z.number().optional(), notes: z.array(z.string()).default([]) }).default({ notes: [] }),
  rules: z.array(ElementId).default([]),
  guidance: z.object({ do: z.array(z.string()).default([]), dont: z.array(z.string()).default([]) }).default({ do: [], dont: [] }),
  examples: z.array(z.object({ title: z.string(), code: z.string() })).max(3).default([]),
  /** Other exported names for the same implementation (e.g. `buttonVariants`). */
  aliases: z.array(z.string()).default([]),
  owners: z.array(z.string()).default([]),
  deprecation: z.object({ replacement: ElementId.optional(), removeIn: SemVer.optional(), note: z.string() }).optional(),
});
export type ComponentContract = z.infer<typeof ComponentContract>;

/* ------------------------------------------------------------------ youi.rule/v1 */

export const RuleCheck = z.discriminatedUnion("engine", [
  /** A built-in structural check run by the youi scanner (ast-grep + import resolution). */
  z.object({ engine: z.literal("youi"), id: z.enum(["raw-color", "native-element", "lookalike-component", "arbitrary-value", "prop-values"]), options: z.record(z.string(), z.unknown()).default({}) }),
  /** A plain ast-grep rule body, emitted as-is to the project's youi-rules/ directory. */
  z.object({ engine: z.literal("ast-grep"), language: z.enum(["tsx", "typescript", "css"]), rule: z.record(z.string(), z.unknown()) }),
  /** Prose only: shown to people and agents, never claimed as enforced. */
  z.object({ engine: z.literal("advisory") }),
]);

export const RuleSpec = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.rule/v1"),
  id: ElementId,
  title: z.string().min(1),
  severity: z.enum(["error", "warn", "off"]),
  statement: z.string().min(1),
  rationale: z.string().default(""),
  /** One imperative line for agent instructions (AGENTS.md, SKILL.md). */
  agent: z.string().min(1),
  check: RuleCheck,
  files: z.array(z.string()).default(["**/*.{ts,tsx,css}"]),
  examples: z.object({ bad: z.array(z.string()).default([]), good: z.array(z.string()).default([]) }).default({ bad: [], good: [] }),
});
export type RuleSpec = z.infer<typeof RuleSpec>;

/* ------------------------------------------------------------- youi.migration/v1 */

export const MigrationChange = z.union([
  z.object({ renameProp: z.object({ from: z.string(), to: z.string() }) }),
  z.object({ mapValues: z.object({ prop: z.string(), map: z.record(z.string(), z.string()) }) }),
]);
export type MigrationChange = z.infer<typeof MigrationChange>;

export const MigrationSpec = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.migration/v1"),
  id: ElementId,
  element: ElementId,
  from: z.string(),
  to: SemVer,
  changes: z.array(MigrationChange).min(1),
  /** Declared change in usage count (0 for renames: every site must survive). */
  expectedUsageDelta: z.number().int().default(0),
});
export type MigrationSpec = z.infer<typeof MigrationSpec>;

/* ----------------------------------------------------------------- youi.usage/v1 */

export const PropValue = z.union([
  z.object({ literal: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ dynamic: z.string() }),
]);
export type PropValue = z.infer<typeof PropValue>;

export const Position = z.object({ file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() });

export const UsageSite = Position.extend({
  element: ElementId,
  /** render: `<Button>`; variants: `buttonVariants()` applied elsewhere; reference: passed as a value. */
  kind: z.enum(["render", "variants", "reference"]),
  local: z.string(),
  props: z.record(z.string(), PropValue).default({}),
  spread: z.boolean().default(false),
  routes: z.array(z.string()),
  /** How the routes were attributed: the file is a route, or reaches one through imports, or neither. */
  routeSource: z.enum(["route-file", "imported-by", "shell", "unrouted"]),
  via: z.string().optional(),
  fingerprint: z.string(),
});
export type UsageSite = z.infer<typeof UsageSite>;

export const UnknownSite = Position.extend({
  name: z.string(),
  reason: z.enum(["unresolved-import", "external-module", "dynamic-component", "namespace-member", "parse-error", "unresolved-export"]),
  detail: z.string(),
  /** The element this might be, by name only; never counted as a usage. */
  candidate: ElementId.optional(),
});
export type UnknownSite = z.infer<typeof UnknownSite>;

export const Lookalike = Position.extend({
  /** The design-system element whose name this shares. */
  resembles: ElementId,
  local: z.string(),
  resolved: z.string(),
});
export type Lookalike = z.infer<typeof Lookalike>;

export const Violation = Position.extend({
  rule: ElementId,
  severity: z.enum(["error", "warn"]),
  message: z.string(),
  text: z.string(),
  suggestion: z.string().optional(),
});
export type Violation = z.infer<typeof Violation>;

export const ScanReport = z.object({
  schema: z.literal("youi.usage/v1"),
  project: z.string(),
  system: z.string(),
  commit: z.string().nullable(),
  scanner: z.string(),
  configDigest: z.string(),
  generatedAt: IsoTime,
  durationMs: z.number(),
  status: z.enum(["complete", "partial"]),
  coverage: z.object({
    filesMatched: z.number().int(),
    filesScanned: z.number().int(),
    failed: z.array(z.object({ file: z.string(), reason: z.string() })),
  }),
  usages: z.array(UsageSite),
  unknowns: z.array(UnknownSite),
  /** Violations silenced by a `youi-ignore` comment (counted so silence stays visible). */
  suppressed: z.number().int().default(0),
  lookalikes: z.array(Lookalike),
  violations: z.array(Violation),
});
export type ScanReport = z.infer<typeof ScanReport>;

/* ------------------------------------------------------------------ youi.lock/v1 */

export const LockEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generated"), sha256: z.string().length(64) }),
  z.object({
    kind: z.literal("vendored"),
    elements: z.array(ElementId).min(1),
    version: SemVer,
    /** Hash of the file as youi last wrote it; a different hash on disk is local drift. */
    sha256: z.string().length(64),
    /** Hash of the upstream file at `version`; its content is kept in `.youi/base/` for 3-way merges. */
    baseSha256: z.string().length(64),
  }),
]);
export type LockEntry = z.infer<typeof LockEntry>;

export const LockFile = z.object({
  schema: z.literal("youi.lock/v1"),
  system: z.string(),
  systemVersion: SemVer,
  sourceCommit: z.string().nullable(),
  syncedAt: IsoTime,
  files: z.record(z.string(), LockEntry),
});
export type LockFile = z.infer<typeof LockFile>;

/** Every published schema, keyed by its file name under `schema/`. */
export const PUBLISHED_SCHEMAS = {
  "youi.config.schema.json": DesignConfig,
  "youi.project.schema.json": ProjectConfig,
  "youi.component.schema.json": ComponentContract,
  "youi.rule.schema.json": RuleSpec,
  "youi.migration.schema.json": MigrationSpec,
  "youi.usage.schema.json": ScanReport,
  "youi.lock.schema.json": LockFile,
} as const;
