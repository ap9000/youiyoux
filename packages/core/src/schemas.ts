/**
 * The design language's file formats. Every schema here is the single source
 * for both runtime validation and the published JSON Schema (`schema/*.json`).
 */
import { posix } from "node:path";
import { z } from "zod";
import { DetectReport } from "./detect.ts";
import { LibraryEntry } from "./hierarchy.ts";
import { ElementId } from "./ids.ts";
import { TokenDocument } from "./tokens.ts";

const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "expected semver x.y.z");
/** `./src/ui/` and `src//ui` mean `src/ui`; compared with scanner paths, an unnormalized path would silently match nothing. */
export function normalizeRelPath(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !normalizeRelPath(p).split("/").includes(".."), "expected a path relative to its root, without ..");
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
  skillDir: RelPath.default(".agents/skills/youiyoux"),
  /** Also expose the skill at `.claude/skills/youiyoux` (a symlink). */
  claudeSkillLink: z.boolean().default(true),
});

export const ProjectConfig = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.project/v1"),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  system: z.string(),
  /** Path to the design repo checkout (the directory holding youi.config.json), relative to this config file or absolute. */
  source: z.object({ path: z.string().min(1) }),
  /** The product root, relative to this config file or absolute; for a config kept outside the product. Default: the --project directory. */
  root: z.string().min(1).optional(),
  tsconfig: RelPath.default("tsconfig.json"),
  include: z.array(z.string()).min(1),
  exclude: z.array(z.string()).default([]),
  /** Where owned (vendored) components live; their files are the canonical implementations. */
  componentsDir: RelPath,
  /** How code imports the owned components (e.g. "@/components/ui"); defaults to componentsDir. */
  importFrom: z.string().optional(),
  /** Files allowed to define raw colour values (the token source of truth or its generated copy). */
  tokenSources: z.array(z.string()).default([]),
  routes: RouteConfig.default({ strategy: "none", appDir: "app", map: [], shell: [] }),
  outputs: OutputConfig.default({ dir: "src/design", cssVarPrefix: "youi", dark: DEFAULT_DARK_SELECTORS, targets: ["css-vars", "tailwind-v4", "ts"], tailwind: { includeAll: true, map: {} } }),
  agents: AgentConfig.default({ agentsMd: "AGENTS.md", designMd: "DESIGN.md", skillDir: ".agents/skills/youiyoux", claudeSkillLink: true }),
  /** Hub specimens. css: the stylesheets a page loads, relative to the product root, exactly and in this order, when finding them from its code, HTML and imports gets them wrong; also read from a config kept outside the product (--config with root). */
  specimens: z.object({ css: z.array(RelPath).optional() }).optional(),
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

/** Interaction states a contract may bind tokens for, in the order a person meets them. */
export const COMPONENT_STATES = ["hover", "active", "focus", "disabled"] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/** A token role (`bg.default`, `ring`): it names a CSS variable, so lowercase words joined by dots or dashes. */
const SlotName = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, "expected lowercase words joined by . or - (bg.default)");

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
  /**
   * Tokens per interaction state: state → role → token. A role may override one in `tokens`
   * (`bg.default` on hover) or exist only in a state (`ring` on focus). The token build emits
   * each as `--<prefix>-<component>-<state>-<role>`, which the owned implementation reads.
   */
  states: z.partialRecord(z.enum(COMPONENT_STATES), z.record(SlotName, ElementId)).optional(),
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

/**
 * A planned tightening: the rule ships as a warning now and becomes an error later. The
 * severity never changes by itself; a person approves the tightening as its own change.
 */
export const RuleRollout = z.object({
  to: z.literal("error"),
  /** The date the team intends to tighten it (YYYY-MM-DD). */
  after: z.iso.date().optional(),
  note: z.string().optional(),
});
export type RuleRollout = z.infer<typeof RuleRollout>;

export const RuleSpec = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.rule/v1"),
  id: ElementId,
  title: z.string().min(1),
  severity: z.enum(["error", "warn", "off"]),
  rollout: RuleRollout.optional(),
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

/** A JavaScript identifier: export names are written into source by the import rewrite. */
const ExportName = z.string().regex(/^[A-Za-z_$][\w$]*$/, "expected an identifier");

export const MigrationChange = z.union([
  z.object({ renameProp: z.object({ from: z.string(), to: z.string() }) }),
  z.object({ mapValues: z.object({ prop: z.string(), map: z.record(z.string(), z.string()) }) }),
  /** The element's file exports `to` instead of `from`: imports, re-exports and their uses are rewritten. */
  z.object({ renameExport: z.object({ from: ExportName, to: ExportName, renameBarrels: z.boolean().optional().default(false) }).refine((r) => r.from !== r.to, "from and to must differ") }),
  /** The element's file no longer exports `name`: imports move to `replacement` (exported by the same file), or are reported when there is none. */
  z.object({ removeExport: z.object({ name: ExportName, replacement: ExportName.optional() }).refine((r) => r.name !== r.replacement, "replacement must differ from name") }),
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

export const RouteAttribution = z.object({
  routes: z.array(z.string()),
  /** The file is a route, is reached through imports, wraps routes, or has no known route. */
  routeSource: z.enum(["route-file", "imported-by", "shell", "unrouted"]),
  via: z.string().optional(),
  /** Why the file could not be placed on a screen. */
  routeReason: z.string().min(1).optional(),
});
export type RouteAttribution = z.infer<typeof RouteAttribution>;

export const UsageSite = Position.extend(RouteAttribution.shape).extend({
  element: ElementId,
  /** render: `<Button>`; variants: `buttonVariants()` applied elsewhere; reference: passed as a value. */
  kind: z.enum(["render", "variants", "reference"]),
  /** The canonical export used: the element itself, a sub-part (CardHeader) or its variants function. */
  export: z.string(),
  local: z.string(),
  props: z.record(z.string(), PropValue).default({}),
  spread: z.boolean().default(false),
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

export const RuleRun = z.object({
  rule: ElementId,
  /**
   * ran: checked every file its globs match. off / advisory: not checked, by design.
   * unsupported / error: it should have been checked but was not, so the scan is partial.
   */
  state: z.enum(["ran", "off", "advisory", "unsupported", "error"]),
  reason: z.string().optional(),
  findings: z.number().int().optional(),
});
export type RuleRun = z.infer<typeof RuleRun>;

export const ScanReport = z.object({
  schema: z.literal("youi.usage/v1"),
  project: z.string(),
  system: z.string(),
  /** HEAD of the project when scanned; `content` says whether the scanned files differ from it. */
  commit: z.string().nullable(),
  scanner: z.string(),
  /** Digest of everything that decides the findings: project config, full contracts and rules, resolved tokens, scanner version. */
  configDigest: z.string(),
  /** Exactly what was scanned: a digest of every file's path and content, and which files differ from `commit`. */
  content: z
    .object({
      digest: z.string(),
      /** Scanned files that differ from `commit` (modified, staged or untracked) or were overridden: the first 50. */
      dirty: z.array(z.string()),
      /** null when there is no commit to compare with. */
      dirtyCount: z.number().int().nullable(),
      /** Files checked from supplied text (unsaved edits, candidate code) rather than disk. */
      overrides: z.array(z.string()),
    })
    .optional(),
  generatedAt: IsoTime,
  durationMs: z.number(),
  status: z.enum(["complete", "partial"]),
  coverage: z.object({
    filesMatched: z.number().int(),
    filesScanned: z.number().int(),
    failed: z.array(z.object({ file: z.string(), reason: z.string() })),
  }),
  usages: z.array(UsageSite),
  /** Every scanned file, including files with no element sites. Absent in older usage maps. */
  fileRoutes: z.record(z.string(), RouteAttribution).optional(),
  unknowns: z.array(UnknownSite),
  /** Violations silenced by a `youi-ignore` comment (counted so silence stays visible). */
  suppressed: z.number().int().default(0),
  lookalikes: z.array(Lookalike),
  violations: z.array(Violation),
  /** How each rule was executed in this scan. Empty in scans made before rules reported it. */
  checks: z.array(RuleRun).default([]),
});
export type ScanReport = z.infer<typeof ScanReport>;

/* -------------------------------------------------------------- youi.baseline/v1 */

/** Where a check result came from: tool, exact definitions and both repos' revisions. */
export const CheckIdentity = z.object({
  /** Scanner version that produced the findings. */
  tool: z.string(),
  system: z.object({ id: z.string(), version: SemVer }),
  /** Digest of everything that decides findings: project config, contracts, rules and resolved token values. */
  definitions: z.string(),
  /** The design repo's revision; `dirty` means its working tree differs from the commit. */
  design: z.object({ commit: z.string().nullable(), dirty: z.boolean() }),
  project: z.object({ commit: z.string().nullable(), dirty: z.boolean() }),
});
export type CheckIdentity = z.infer<typeof CheckIdentity>;

export const BaselineEntry = z.object({
  rule: ElementId,
  file: z.string(),
  /** The flagged source text; with rule and file it identifies a finding across line moves. */
  text: z.string(),
  severity: z.enum(["error", "warn"]),
  count: z.number().int().min(1),
  /** Lines when recorded: a hint for which occurrence is the new one, never part of the match. */
  lines: z.array(z.number().int()),
});
export type BaselineEntry = z.infer<typeof BaselineEntry>;

/** Accepted existing violations: `youi check --baseline` fails only on findings beyond these. */
export const Baseline = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.baseline/v1"),
  project: z.string(),
  recordedAt: IsoTime,
  identity: CheckIdentity,
  totals: z.object({ errors: z.number().int(), warnings: z.number().int() }),
  entries: z.array(BaselineEntry),
});
export type Baseline = z.infer<typeof Baseline>;

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

/* ------------------------------------------------------------- youi.inventory/v1 */

/** What a look is for, read only from element and component names and ARIA roles, never from class names. */
export const INVENTORY_ROLES = ["button", "link-as-button", "input", "card", "badge", "dialog", "tabs"] as const;
export const InventoryRole = z.enum(INVENTORY_ROLES);
export type InventoryRole = z.infer<typeof InventoryRole>;

/** The dimensions a look is grouped by, in px (weight as a number); colour is never part of it. null: not resolved. */
export const SHAPE_DIMENSIONS = ["height", "paddingX", "paddingY", "radius", "fontSize", "fontWeight"] as const;
export type ShapeDimension = (typeof SHAPE_DIMENSIONS)[number];
export const InventoryShape = z.object(Object.fromEntries(SHAPE_DIMENSIONS.map((d) => [d, z.number().nullable()])) as Record<ShapeDimension, z.ZodNullable<z.ZodNumber>>);
export type InventoryShape = z.infer<typeof InventoryShape>;

const ProjectPosition = z.object({ project: z.string(), file: z.string(), line: z.number().int().positive() });

export const InventoryProject = z.object({
  id: z.string(),
  /** The directory inventoried, as it was named (relative to where youi ran, or absolute). */
  root: z.string(),
  commit: z.string().nullable(),
  /** `partial`: some files could not be read or parsed, so some looks may be missing. */
  status: z.enum(["complete", "partial"]),
  files: z.number().int(),
  /** How routes were found: the project config, a detected router, or none. */
  routes: z.string(),
  failed: z.array(z.object({ file: z.string(), reason: z.string() })),
  /** Theme or config that could not be read statically (it falls back to Tailwind's defaults). */
  warnings: z.array(z.string()),
  /**
   * Its Storybook stories, read statically (never run), when it has any: story files found, stories
   * read, stories drawn as authored looks, and each one skipped with file:line and why. `notes`:
   * what was left out of stories that were drawn (a decorator, global decorators). Additive.
   */
  stories: z
    .object({
      files: z.number().int(),
      read: z.number().int(),
      drawn: z.number().int(),
      skipped: z.array(ProjectPosition.omit({ project: true }).extend({ name: z.string(), reason: z.string() })),
      notes: z.array(z.string()),
    })
    .optional(),
});
export type InventoryProject = z.infer<typeof InventoryProject>;

export const InventoryDefinition = ProjectPosition.extend({
  /** `<project>:<file>#<export>`. */
  id: z.string(),
  name: z.string(),
  /** react: an exported JSX component; astro: an .astro file; class: a block in a class kit (`.ui-button`). */
  kind: z.enum(["react", "astro", "class"]),
  kit: z.string().nullable(),
  role: InventoryRole.nullable(),
  /** Variant name → values, from a CVA table or a class kit's `--modifier` classes. */
  variants: z.record(z.string(), z.array(z.string())).default({}),
});
export type InventoryDefinition = z.infer<typeof InventoryDefinition>;

export const InventoryKit = z.object({
  /** `<project>:<folder or stylesheet>`. */
  id: z.string(),
  project: z.string(),
  /** cva-folder: a folder of components calling cva(); class-kit: a stylesheet's BEM blocks sharing a prefix, and its plain classes named for an element that set a shape (`.badge`). */
  kind: z.enum(["cva-folder", "class-kit"]),
  path: z.string(),
  /** The block prefix, when the stylesheet has exactly one prefixed kit. */
  prefix: z.string().optional(),
  members: z.array(z.object({ name: z.string(), role: InventoryRole.nullable(), file: z.string(), line: z.number().int().positive(), variants: z.record(z.string(), z.array(z.string())).default({}) })),
});
export type InventoryKit = z.infer<typeof InventoryKit>;

export const InventoryPrimitive = z.object({
  /** The npm package (`@radix-ui/react-tabs`, `lucide-react`). */
  package: z.string(),
  project: z.string(),
  exports: z.array(z.string()),
  count: z.number().int(),
  /** The first sites, in file order. */
  sites: z.array(ProjectPosition.extend({ column: z.number().int().positive(), export: z.string() })),
});
export type InventoryPrimitive = z.infer<typeof InventoryPrimitive>;

/** Literal props a site passes (`variant="outline"`, `value="runs"`); computed ones are left out. */
const RecipeProps = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/** A component of the same module the site renders the look inside (Tabs > TabsList for a TabsTrigger). */
export const InventoryRecipeWrapper = z.object({ file: z.string(), export: z.string(), props: RecipeProps, dynamic: z.array(z.string()).optional() });
export type InventoryRecipeWrapper = z.infer<typeof InventoryRecipeWrapper>;

/**
 * How to draw a look for real, at hub snapshot time. component: render the project's own
 * export with these props and label, inside its wrappers (its tag and classes are the static
 * fallback); class: a tag with these classes. Additive: inventories without it stay valid.
 */
export const InventoryRecipe = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("component"),
    /** The defining module, relative to the project root, and the export to render. */
    file: z.string(),
    export: z.string(),
    props: RecipeProps,
    /** Expression props omitted from the specimen. */
    dynamic: z.array(z.string()).optional(),
    /** The site's text children (`Save`), null when it has none. */
    label: z.string().nullable(),
    /** Outermost first. */
    wrappers: z.array(InventoryRecipeWrapper),
    /** Nearest enclosing project component, including across modules. */
    parent: InventoryRecipeWrapper.optional(),
    tag: z.string(),
    classes: z.array(z.string()),
  }),
  z.object({ kind: z.literal("class"), tag: z.string(), classes: z.array(z.string()), label: z.string().nullable() }),
]);
export type InventoryRecipe = z.infer<typeof InventoryRecipe>;

export const InventoryLook = ProjectPosition.extend({
  id: z.string(),
  role: InventoryRole,
  column: z.number().int().positive(),
  routes: z.array(z.string()),
  routeSource: z.enum(["route-file", "imported-by", "shell", "unrouted"]),
  /** component: a rendered definition; intrinsic: a styled native element; primitive: a library tag. */
  source: z.enum(["component", "intrinsic", "primitive"]),
  tag: z.string(),
  definition: z.string().nullable(),
  kit: z.string().nullable(),
  shape: InventoryShape,
  /** Dimensions computed rather than declared (height from padding + line height + border). */
  derived: z.array(z.enum(SHAPE_DIMENSIONS)),
  /** Classes and values that could not be resolved statically (dynamic expressions, unknown utilities). */
  unresolved: z.array(z.string()),
  /** Breakpoint classes and media-query rules: recorded, not clustered. */
  responsive: z.array(z.string()),
  /** State classes and pseudo-class rules (hover:, focus:, data-[…]:, :hover): recorded, not clustered. */
  states: z.array(z.string()),
  /** The family it was grouped into; null when no dimension resolved, so it was not clustered. */
  family: z.string().nullable(),
  recipe: InventoryRecipe.optional(),
  /**
   * A Storybook story (`file:line` is its export): an authored state of its component, not a use.
   * It joins the family of its role it fits within tolerance, and never counts as a look of it.
   */
  story: z.object({ title: z.string(), name: z.string(), id: z.string() }).optional(),
});
export type InventoryLook = z.infer<typeof InventoryLook>;

const InventoryExample = ProjectPosition.extend({ column: z.number().int().positive(), tag: z.string(), routes: z.array(z.string()) });

export const InventoryFamily = z.object({
  id: z.string(),
  role: InventoryRole,
  /** The shape most of its looks have. */
  shape: InventoryShape,
  /** Smallest and largest value of each dimension across its looks: never wider than the tolerance. */
  range: z.record(z.enum(SHAPE_DIMENSIONS), z.tuple([z.number(), z.number()]).nullable()),
  looks: z.number().int(),
  shapes: z.number().int(),
  projects: z.array(z.string()),
  kits: z.array(z.string()),
  examples: z.array(InventoryExample),
  /** It spans more than one project or kit: the same look built more than once. */
  nearDuplicate: z.boolean(),
  /** Each project-and-kit side of the family, with its own examples. */
  sides: z.array(z.object({ project: z.string(), kit: z.string().nullable(), looks: z.number().int(), examples: z.array(InventoryExample) })),
  /** Storybook stories drawn as authored states of it, beside its looks (never counted in `looks`). */
  stories: z.number().int().optional(),
  /** Only stories have this shape: no look in any project does (`looks` is 0; `examples` are the stories). */
  authored: z.boolean().optional(),
});
export type InventoryFamily = z.infer<typeof InventoryFamily>;

export const InventoryFlag = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("duplicate-definition"), name: z.string(), locations: z.array(ProjectPosition.extend({ kit: z.string().nullable() })) }),
  z.object({ kind: z.literal("mixed-kits"), project: z.string(), file: z.string(), role: InventoryRole, imports: z.array(z.object({ kit: z.string(), name: z.string(), specifier: z.string(), line: z.number().int().positive() })) }),
]);
export type InventoryFlag = z.infer<typeof InventoryFlag>;

export const InventoryReport = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.inventory/v1"),
  scanner: z.string(),
  generatedAt: IsoTime,
  durationMs: z.number(),
  /** Two looks share a family only when every dimension is within these (px; weight in units) of every other look's. */
  tolerance: z.object({ height: z.number(), padding: z.number(), radius: z.number(), fontSize: z.number(), fontWeight: z.number() }),
  projects: z.array(InventoryProject),
  definitions: z.array(InventoryDefinition),
  kits: z.array(InventoryKit),
  primitives: z.array(InventoryPrimitive),
  looks: z.array(InventoryLook),
  families: z.array(InventoryFamily),
  flags: z.array(InventoryFlag),
  summary: z.object({
    looks: z.number().int(),
    clustered: z.number().int(),
    /** Looks with no resolved dimension: listed, never grouped. */
    unshaped: z.number().int(),
    /** Breakpoint and state classes and rules recorded on looks; they never decide a family. */
    notClustered: z.number().int(),
    /** Storybook stories drawn as authored looks; `looks`, `clustered` and `unshaped` count real looks only. */
    stories: z.number().int().optional(),
  }),
});
export type InventoryReport = z.infer<typeof InventoryReport>;

/** Every published schema, keyed by its file name under `schema/`. */
export const PUBLISHED_SCHEMAS = {
  "youi.config.schema.json": DesignConfig,
  "youi.project.schema.json": ProjectConfig,
  "youi.component.schema.json": ComponentContract,
  "youi.rule.schema.json": RuleSpec,
  "youi.migration.schema.json": MigrationSpec,
  "youi.usage.schema.json": ScanReport,
  "youi.lock.schema.json": LockFile,
  "youi.library.schema.json": LibraryEntry,
  "youi.baseline.schema.json": Baseline,
  "youi.inventory.schema.json": InventoryReport,
  "youi.detect.schema.json": DetectReport,
  "youi.tokens.schema.json": TokenDocument,
} as const;

/** Project config with every path normalized, so comparisons with scanned paths are exact. Loaders call this. */
export function normalizeProjectConfig(config: ProjectConfig): ProjectConfig {
  const n = normalizeRelPath;
  return {
    ...config,
    tsconfig: n(config.tsconfig),
    componentsDir: n(config.componentsDir),
    tokenSources: config.tokenSources.map(n),
    routes: { ...config.routes, appDir: n(config.routes.appDir) },
    outputs: { ...config.outputs, dir: n(config.outputs.dir) },
    agents: { ...config.agents, agentsMd: n(config.agents.agentsMd), designMd: n(config.agents.designMd), skillDir: n(config.agents.skillDir) },
  };
}
