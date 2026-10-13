/**
 * A youi.inventory/v1 file as the Inventory page loads it: a small index (projects, roles by
 * project, counts) for the first paint, a chunk per project and role (its looks, their families
 * and specimens) fetched when that role nears the screen, an extras file (kits, primitives,
 * flags), and each project's specimen stylesheets. The snapshot writes them under content
 * hashes; the page splits an older single-file snapshot the same way, in memory.
 */
import { ROLES } from "./inventory.ts";
import type { ChunkLook, InventoryChunk, InventoryExtras, InventoryIndex, InventoryReport, Specimen } from "./types.ts";

/** A project's specimens, as the snapshot built them. */
export interface SplitSpecimens {
  css: { light: string; dark: string } | null;
  /** Specimen id → specimen. */
  specimens: Record<string, Specimen>;
  /** Look id → specimen id. */
  looks: Record<string, string>;
  notes: string[];
}

export interface SplitFile {
  name: string;
  text: string;
}

/** Names a file from a stem (`inventory.console.button`), its extension and its text. */
export type FileNamer = (stem: string, ext: "json" | "css", text: string) => string;

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
const stemOf = (id: string): string => id.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

export function splitInventory(report: InventoryReport, specimens: Readonly<Record<string, SplitSpecimens>>, name: FileNamer): { index: InventoryIndex; files: SplitFile[] } {
  const files: SplitFile[] = [];
  const add = (stem: string, ext: "json" | "css", text: string): string => {
    const file = name(stem, ext, text);
    files.push({ name: file, text });
    return file;
  };
  const projects = report.projects.map((p) => {
    const built = specimens[p.id];
    const specimenCss = built?.css ? { light: add(`specimens.${stemOf(p.id)}.light`, "css", built.css.light), dark: add(`specimens.${stemOf(p.id)}.dark`, "css", built.css.dark) } : null;
    return { id: p.id, root: p.root, commit: p.commit, status: p.status, files: p.files, routes: p.routes, failed: p.failed.length, warnings: p.warnings, specimenCss, specimenNotes: built?.notes ?? ["no specimens were built: looks show their shape"] };
  });
  const roles = ROLES.flatMap((role) => {
    // Chunks carry stories so their tiles can be drawn; every count is of real looks.
    const all = report.looks.filter((l) => l.role === role);
    if (all.length === 0) return [];
    const looks = all.filter((l) => !l.story);
    const families = report.families.filter((f) => f.role === role);
    const cells: InventoryIndex["roles"][number]["cells"] = {};
    const chunks: Record<string, string> = {};
    for (const project of report.projects) {
      const mine = all.filter((l) => l.project === project.id);
      const used = mine.filter((l) => !l.story);
      cells[project.id] = { families: new Set(mine.flatMap((l) => (l.family ? [l.family] : []))).size, looks: used.length };
      if (mine.length === 0) continue;
      const built = specimens[project.id];
      const drawn: Record<string, Specimen> = {};
      const chunkLooks: ChunkLook[] = mine.map((l) => {
        const id = built?.looks[l.id];
        const specimen = id ? built.specimens[id] : undefined;
        if (id && specimen) drawn[id] = specimen;
        return { id: l.id, file: l.file, line: l.line, column: l.column, tag: l.tag, kit: l.kit, family: l.family, shape: l.shape, specimen: id && specimen ? id : null, ...(l.story ? { story: l.story } : {}) };
      });
      const chunk: InventoryChunk = { schema: "youiyoux.inventory-chunk/v1", project: project.id, role, families: families.filter((f) => f.projects.includes(project.id)), looks: chunkLooks, specimens: drawn };
      chunks[project.id] = add(`inventory.${stemOf(project.id)}.${role}`, "json", json(chunk));
    }
    return [{ role, looks: looks.length, unshaped: looks.filter((l) => l.family === null).length, families: families.length, shared: families.filter((f) => f.nearDuplicate && f.projects.length > 1).length, cells, chunks }];
  });
  const extras: InventoryExtras = { schema: "youiyoux.inventory-extras/v1", kits: report.kits, primitives: report.primitives, flags: report.flags };
  const index: InventoryIndex = {
    schema: "youiyoux.inventory-index/v1",
    scanner: report.scanner,
    generatedAt: report.generatedAt,
    tolerance: report.tolerance,
    projects,
    // Families only stories have are drawn, but not counted among the families built.
    summary: { ...report.summary, families: report.families.filter((f) => !f.authored).length, nearDuplicates: report.families.filter((f) => f.nearDuplicate).length, flags: report.flags.length },
    roles,
    extras: add("inventory.extras", "json", json(extras)),
  };
  return { index, files };
}
