/**
 * The shapes the hub reads. Design-language formats (contracts, rules, usage maps) are
 * @youiyoux/core's own types, imported type-only so no validation code ships to the
 * browser: `pnpm data` validates every snapshot with core's schemas when it writes them.
 * The hub's snapshot shapes follow.
 */
import type { ComponentContract, ElementId, InventoryFamily, InventoryFlag, InventoryKit, InventoryReport, InventoryRole, InventoryShape, RuleSpec } from "@youiyoux/core";
import type { RuleExecution } from "@youiyoux/core/rules";

export type {
  ComponentContract,
  DetectElement,
  DetectEvidence,
  DetectLibrary,
  DetectReport,
  ElementId,
  ElementKind,
  InventoryFamily,
  InventoryFlag,
  InventoryReport,
  InventoryRole,
  InventoryShape,
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
  /** The DTCG `$value` as written per scheme, aliases kept (`{color.brand}`): what the style editor edits. Absent in older snapshots. */
  source?: { light: unknown; dark: unknown };
  /** True when the dark context gives this token its own value; otherwise dark follows light. */
  darkOwn?: boolean;
}

export interface ComponentEntry {
  contract: ComponentContract;
  /** The owned files a project vendors: the component source plus the system's support files. */
  files: Array<{ path: string; code: string }>;
}

interface SystemInfo {
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
  rules: CatalogRule[];
}

/** A rule with how youiyoux check runs it, compiled when the snapshot was built (older snapshots lack it). */
export type CatalogRule = RuleSpec & { execution?: RuleExecution };

/** How a live snapshot (`youiyoux ui --watch`) was produced; absent from one-off snapshots. */
interface LiveInfo {
  /** Increases with every re-scan. */
  generation: number;
  /** `partial`: some files could not be analysed; `failed`: the latest run failed and older data is shown. */
  status: "complete" | "partial" | "failed";
  updatedAt: string;
  /** The rules the usage map was checked against: system, definitions digest and revisions. */
  rules?: string;
  message?: string;
}

/** A route's screenshot in one scheme: a 2x image for the screen page and a small one for thumbnails. */
interface ShotFiles {
  full: string;
  thumb: string;
}

export interface ScreenShot {
  /** The route as the usage map names it (`/flows`, `*` for the app shell). */
  route: string;
  /** The address that was captured. */
  path: string;
  /** Why this address stands for the route, when that is not obvious. */
  note?: string;
  light?: ShotFiles;
  dark?: ShotFiles;
  /** Where each component sits on the light picture (youiyoux.places/v1), when the capture placed them. */
  places?: string;
}

/** A component on a captured screen: its box in CSS pixels of the page, and the line that rendered it. */
export interface PlacedComponent {
  name: string;
  owner: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  box: { x: number; y: number; width: number; height: number };
  depth: number;
}

export interface PlacesFile {
  schema: "youiyoux.places/v1";
  route: string;
  path: string;
  viewport: { width: number; height: number };
  size: { width: number; height: number };
  dev: boolean;
  capped: boolean;
  places: PlacedComponent[];
}

/** A project's captured screens (`fixtures/<project>.screens.json` plus its images). */
export interface ProjectShots {
  /** Where the pictures came from, e.g. a seeded demo sandbox at a commit. */
  source: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  screens: ScreenShot[];
}

export interface Manifest {
  schema: "youiyoux.manifest/v1";
  source: { commit: string | null };
  systems: Array<{ id: string; catalog: string; usage: Array<{ project: string; file: string; screens?: ProjectShots }> }>;
  /**
   * The Inventory page's index (youiyoux.inventory-index/v1, split from a `youiyoux inventory` file
   * by the snapshot), or a whole youi.inventory/v1 file in snapshots older than the split;
   * absent when none was given.
   */
  inventory?: string;
  /** A `youiyoux detect` report (`youiyoux ui --detect`), for Library > Stack; its screenshots are data files named in it. */
  detect?: { file: string; name: string; kind: "repo" | "site" };
  /** Every file the index names (its chunks and specimen stylesheets), so caches keep them. */
  inventoryFiles?: string[];
  /** Discover's listings (youiyoux.discover-listings/v1) for a static host, which has no /__youi/query; absent when no Discover cache was synced. */
  discover?: string;
  /** Gaps (youi.gaps/v1) for the inventoried projects, for Library > Gaps; absent without an inventory. */
  gaps?: string;
  live?: LiveInfo;
}

/* ------------------------------------------------------- the Inventory page's data */

/** How a look is drawn: component, server-rendered from its project's code; markup, a tag with its classes. */
export interface Specimen {
  kind: "component" | "markup";
  html: string;
}

interface InventoryIndexProject {
  id: string;
  root: string;
  commit: string | null;
  status: "complete" | "partial";
  files: number;
  routes: string;
  /** Files not fully read (the full list is in the inventory file). */
  failed: number;
  warnings: string[];
  /** Its specimen stylesheets, light and dark; null when none was built (its looks show their shape). */
  specimenCss: { light: string; dark: string } | null;
  /** How the specimens were built, and what fell back. */
  specimenNotes: string[];
}

export interface InventoryRoleIndex {
  role: InventoryRole;
  /** Real looks; Storybook stories are not uses and are counted apart. */
  looks: number;
  unshaped: number;
  families: number;
  /** Families with looks in more than one project. */
  shared: number;
  /** Per project id: its families and looks of this role. */
  cells: Record<string, { families: number; looks: number }>;
  /** Per project id with looks of this role: its chunk file. */
  chunks: Record<string, string>;
}

/**
 * What the Inventory page needs for its first paint, and no more: its size depends on the
 * number of projects and roles, never on the number of looks.
 */
export interface InventoryIndex {
  schema: "youiyoux.inventory-index/v1";
  scanner: string;
  generatedAt: string;
  tolerance: InventoryReport["tolerance"];
  projects: InventoryIndexProject[];
  summary: InventoryReport["summary"] & { families: number; nearDuplicates: number; flags: number };
  roles: InventoryRoleIndex[];
  /** Kits, primitives and flags: loaded after the first paint. */
  extras: string;
}

/** A trimmed look: where it is and what draws it. */
export interface ChunkLook {
  id: string;
  file: string;
  line: number;
  column: number;
  tag: string;
  kit: string | null;
  family: string | null;
  shape: InventoryShape;
  /** Its specimen's id in the chunk; null when none was built. */
  specimen: string | null;
  /** A Storybook story: an authored state of its component, shown beside the uses, never counted as one. */
  story?: { title: string; name: string; id: string };
}

/** One project's looks of one role, the families they belong to, and their specimens. */
export interface InventoryChunk {
  schema: "youiyoux.inventory-chunk/v1";
  project: string;
  role: InventoryRole;
  families: InventoryFamily[];
  looks: ChunkLook[];
  specimens: Record<string, Specimen>;
}

export interface InventoryExtras {
  schema: "youiyoux.inventory-extras/v1";
  kits: InventoryKit[];
  primitives: InventoryReport["primitives"];
  flags: InventoryFlag[];
}
