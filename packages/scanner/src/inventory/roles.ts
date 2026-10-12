/**
 * Roles come from what an element is called and what it says it is: its tag, its ARIA role,
 * its component name, or the kit member it uses: a block of a prefixed kit, or a stylesheet class
 * named for an element that sets a shape (`.badge`). Never from utility classes on an element.
 */
import type { InventoryRole, PropValue } from "@youiyoux/core";

/** Component-name suffixes, most specific first. */
const NAME_ROLES: ReadonlyArray<readonly [RegExp, InventoryRole]> = [
  [/(?:ButtonLink|LinkButton)$/, "link-as-button"],
  [/Button$/, "button"],
  [/(?:Input|Textarea|TextArea|^Select|SelectTrigger|Combobox)$/, "input"],
  [/Card$/, "card"],
  [/(?:Badge|Pill)$/, "badge"],
  [/(?:Dialog|DialogContent|Modal|ModalContent)$/, "dialog"],
  [/(?:Tabs|TabsList|TabsTrigger|^Tab|[a-z]Tab)$/, "tabs"],
];

const ARIA_ROLES: Readonly<Record<string, InventoryRole>> = {
  button: "button",
  tab: "tabs",
  tablist: "tabs",
  dialog: "dialog",
  alertdialog: "dialog",
  textbox: "input",
  searchbox: "input",
  combobox: "input",
};

const NOT_INPUTS = new Set(["checkbox", "radio", "hidden", "range", "file", "color", "image"]);
const INPUT_BUTTONS = new Set(["submit", "button", "reset"]);

/** `TabsPrimitive.Trigger` → `TabsTrigger`, `ui.Button` → `Button`. */
export function componentName(tag: string): string {
  const parts = tag.split(".").map((p) => p.replace(/Primitive$/, ""));
  const last = parts.at(-1) ?? tag;
  return parts.length > 1 && /^[A-Z]/.test(parts[0]!) ? `${parts[0]}${last}` : last;
}

export function roleOfName(name: string): InventoryRole | null {
  const clean = componentName(name);
  return NAME_ROLES.find(([pattern]) => pattern.test(clean))?.[1] ?? null;
}

/** `ui-button` in a kit with prefix `ui-` → `Button` → button. */
export function roleOfBlock(block: string, prefix: string): InventoryRole | null {
  const words = block.slice(prefix.length).split(/[-_]/).filter(Boolean);
  return roleOfName(words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(""));
}

/** Element words a plain stylesheet class may be named by (`.badge`, `.btn-primary`). */
const CLASS_WORDS: Readonly<Record<string, InventoryRole>> = { badge: "badge", pill: "badge", chip: "badge", tag: "badge", card: "card", btn: "button", button: "button" };

/** `.badge` or `.btn-primary` → its role: the whole name or its first segment only, so `.status-badge` is not one. */
export function roleOfClass(name: string): InventoryRole | null {
  return CLASS_WORDS[name] ?? CLASS_WORDS[name.split("-")[0]!] ?? null;
}

const literal = (props: Readonly<Record<string, PropValue>>, name: string): string | null => {
  const value = props[name];
  return value && "literal" in value && typeof value.literal === "string" ? value.literal : null;
};

const isLink = (tag: string): boolean => tag === "a" || /Link$/.test(tag);

/** The role of an intrinsic element, from its tag and ARIA role. */
export function roleOfIntrinsic(tag: string, props: Readonly<Record<string, PropValue>>): InventoryRole | null {
  const aria = literal(props, "role");
  if (aria) {
    const role = ARIA_ROLES[aria];
    if (role === "button" && isLink(tag)) return "link-as-button";
    if (role) return role;
  }
  if (tag === "button") return "button";
  if (tag === "input") {
    const type = literal(props, "type") ?? "text";
    if (INPUT_BUTTONS.has(type)) return "button";
    return NOT_INPUTS.has(type) ? null : "input";
  }
  if (tag === "textarea" || tag === "select") return "input";
  if (tag === "dialog") return "dialog";
  return null;
}

/** A rendered component's role: its ARIA role first, then its name; a button that renders a link is a link-as-button. */
export function roleOfComponent(name: string, props: Readonly<Record<string, PropValue>>, firstChild: string | null): InventoryRole | null {
  const aria = literal(props, "role");
  const role = (aria ? ARIA_ROLES[aria] : undefined) ?? roleOfName(name);
  const asChild = props.asChild && "literal" in props.asChild && props.asChild.literal === true;
  if (role === "button" && ((asChild && firstChild !== null && isLink(firstChild)) || (aria === "button" && isLink(name)))) return "link-as-button";
  return role;
}
