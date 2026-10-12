/** The Inventory page's view of a youi.inventory/v1 file: roles by project, and each role's families. */
import type { InventoryFamily, InventoryReport, InventoryRole, InventoryShape } from "./types.ts";

/** Every role, in the order the CLI reports them (core's INVENTORY_ROLES, kept type-only out of the browser bundle). */
export const ROLES: readonly InventoryRole[] = ["button", "link-as-button", "input", "card", "badge", "dialog", "tabs"];

export const ROLE_LABEL: Readonly<Record<InventoryRole, string>> = {
  button: "Buttons",
  "link-as-button": "Links as buttons",
  input: "Inputs",
  card: "Cards",
  badge: "Badges",
  dialog: "Dialogs",
  tabs: "Tabs",
};

/** One of a role, for a family's name. */
const ROLE_NAME: Readonly<Record<InventoryRole, string>> = {
  button: "Button",
  "link-as-button": "Link as button",
  input: "Input",
  card: "Card",
  badge: "Badge",
  dialog: "Dialog",
  tabs: "Tabs",
};

export interface Cell {
  readonly families: number;
  readonly looks: number;
}

export interface RoleRow {
  readonly role: InventoryRole;
  /** Per project id, in report order. */
  readonly cells: ReadonlyMap<string, Cell>;
  readonly families: readonly InventoryFamily[];
  readonly looks: number;
  /** Looks of this role no dimension resolved for: listed, not grouped. */
  readonly unshaped: number;
}

/** Roles with at least one look, with per-project family and look counts. */
export function roleRows(report: InventoryReport): RoleRow[] {
  return ROLES.flatMap((role) => {
    const looks = report.looks.filter((l) => l.role === role);
    if (looks.length === 0) return [];
    const cells = new Map(
      report.projects.map((p) => {
        const mine = looks.filter((l) => l.project === p.id);
        return [p.id, { families: new Set(mine.flatMap((l) => (l.family ? [l.family] : []))).size, looks: mine.length }] as const;
      }),
    );
    return [{ role, cells, families: report.families.filter((f) => f.role === role), looks: looks.length, unshaped: looks.filter((l) => l.family === null).length }];
  });
}

const PILL = 9999;
const px = (n: number | null): string => (n === null ? "?" : `${n}px`);

/** A family's name from its role and shape: `Button · 32px · radius 8`; unknown parts are left out. */
export function familyName(family: Pick<InventoryFamily, "role" | "shape">): string {
  const { height, radius } = family.shape;
  return [ROLE_NAME[family.role], height !== null ? `${height}px` : null, radius === PILL ? "pill" : radius !== null ? `radius ${radius}` : null].filter((p) => p !== null).join(" · ");
}

/** Shape chips, spelled out: height, padding (vertical then horizontal, as CSS writes it), radius, size, weight; `?` when unknown. */
export function shapeChips(shape: InventoryShape): Array<{ label: string; value: string; known: boolean }> {
  const side = (n: number | null): string => (n === 0 ? "0" : px(n));
  const padding = shape.paddingY === null && shape.paddingX === null ? "?" : `${side(shape.paddingY)} ${side(shape.paddingX)}`;
  return [
    { label: "height", value: px(shape.height), known: shape.height !== null },
    { label: "padding", value: padding, known: shape.paddingX !== null || shape.paddingY !== null },
    { label: "radius", value: shape.radius === PILL ? "pill" : px(shape.radius), known: shape.radius !== null },
    { label: "size", value: px(shape.fontSize), known: shape.fontSize !== null },
    { label: "weight", value: shape.fontWeight === null ? "?" : `${shape.fontWeight}`, known: shape.fontWeight !== null },
  ];
}

/** Examples with one entry per file:line: two looks on one line read as one place. */
export function uniqueExamples<T extends { project: string; file: string; line: number }>(examples: readonly T[]): T[] {
  const seen = new Set<string>();
  return examples.filter((e) => {
    const key = `${e.project}:${e.file}:${e.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `console:src/components/ui` → `src/components/ui`; null → "no kit". */
export function kitLabel(kit: string | null): string {
  return kit ? kit.slice(kit.indexOf(":") + 1) : "no kit";
}

export function roleAnchor(role: InventoryRole): string {
  return `inventory-${role}`;
}
