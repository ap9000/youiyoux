/** The Inventory page's view of a youi.inventory/v1 file: roles by project, and each role's families. */
import type { InventoryFamily, InventoryRole } from "./types.ts";

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

const PILL = 9999;

/** A family's name from its role and shape: `Button · 32px · radius 8`; unknown parts are left out. */
export function familyName(family: Pick<InventoryFamily, "role" | "shape">): string {
  const { height, radius } = family.shape;
  return [ROLE_NAME[family.role], height !== null ? `${height}px` : null, radius === PILL ? "pill" : radius !== null ? `radius ${radius}` : null].filter((p) => p !== null).join(" · ");
}

/** `console:src/components/ui` → `src/components/ui`; null → "no kit". */
export function kitLabel(kit: string | null): string {
  return kit ? kit.slice(kit.indexOf(":") + 1) : "no kit";
}

export function roleAnchor(role: InventoryRole): string {
  return `inventory-${role}`;
}
