/**
 * The fingerprint table: one entry per library, everything `youiyoux detect` knows about it. The
 * website markers were settled in a spike against real sites: class prefixes, CSS custom
 * properties on :root, id prefixes, shadcn's own data-slot names. Each marker says how much it
 * decides on its own: `strong` decides a verdict, `weak` alone only gives low confidence.
 * Radix Colors scales and Tailwind density are never in here as a library's own marker: they
 * only support a verdict something else decided (see SUPPORT).
 */
import type { DetectElementType } from "@youiyoux/core";

export type Strength = "strong" | "weak";

export interface ElementRule {
  readonly type: DetectElementType;
  /** A CSS selector, run in the page. */
  readonly selector: string;
}

export interface LibraryFingerprint {
  readonly id: string;
  readonly name: string;
  /** 2: a component kit; 1: unstyled primitives a kit may be built on; 0: a styling layer. An element matched by two libraries goes to the higher layer. */
  readonly layer: 0 | 1 | 2;
  /** npm packages, exact names. */
  readonly packages: readonly string[];
  /** npm package name prefixes (`@radix-ui/react-`). */
  readonly packagePrefixes?: readonly string[];
  /** Class token pattern (a RegExp source), with a label for evidence. */
  readonly classPattern?: { readonly source: string; readonly label: string; readonly strength: Strength };
  readonly cssVarPrefixes?: ReadonlyArray<{ readonly prefix: string; readonly strength: Strength }>;
  readonly idPrefixes?: readonly string[];
  /** `<style data-styled>`-like attributes the library stamps on the style tags it injects. */
  readonly styleTags?: readonly string[];
  /** Element selectors for websites. */
  readonly elements: readonly ElementRule[];
  /** Package (exact) → the element type importing it means, for primitives split one package per element. */
  readonly packageElements?: Readonly<Record<string, DetectElementType>>;
}

/** Element rules for a kit whose classes follow one naming scheme. */
const byClass = (rules: Partial<Record<DetectElementType, string>>): ElementRule[] =>
  Object.entries(rules).map(([type, selector]) => ({ type: type as DetectElementType, selector: selector! }));

/** Element rules for primitives that stamp generated ids with a prefix, by ARIA role. */
const byIdPrefix = (prefix: string, roles: Partial<Record<DetectElementType, string>>): ElementRule[] =>
  Object.entries(roles).map(([type, role]) => ({ type: type as DetectElementType, selector: role!.split(",").map((r) => `${r.trim()}[id^="${prefix}"]`).join(", ") }));

/** Elements whose class list has a styled-components class (`sc-` plus a hash). */
const styled = (tags: Partial<Record<DetectElementType, string>>): ElementRule[] =>
  Object.entries(tags).map(([type, tag]) => ({ type: type as DetectElementType, selector: `${tag}[class^="sc-"], ${tag}[class*=" sc-"]` }));

/**
 * shadcn/ui's own data-slot names: every slot its v4 registry stamps (new-york-v4 and the Radix,
 * Base UI and React Aria bases, as of October 2026), by component. Only these count: other
 * design systems use data-slot too (Geist's `data-slot="geist-icon"`), and a generic slot is not shadcn.
 */
const SHADCN_PARTS: Record<string, readonly string[]> = {
  accordion: ["", "content", "item", "trigger", "trigger-icon"],
  alert: ["", "action", "description", "title"],
  "alert-dialog": ["", "action", "cancel", "content", "description", "footer", "header", "media", "overlay", "portal", "title", "trigger"],
  "aspect-ratio": [""],
  attachment: ["", "action", "actions", "content", "description", "group", "media", "title", "trigger"],
  avatar: ["", "badge", "fallback", "group", "group-count", "image"],
  badge: [""],
  breadcrumb: ["", "ellipsis", "item", "link", "list", "page", "separator"],
  bubble: ["", "content", "group", "reactions"],
  button: [""],
  "button-group": ["", "separator", "text"],
  calendar: [""],
  card: ["", "action", "content", "description", "footer", "header", "title"],
  carousel: ["", "content", "item", "next", "previous"],
  chart: [""],
  checkbox: ["", "indicator"],
  collapsible: ["", "content", "trigger"],
  combobox: ["chip", "chip-input", "chip-list", "chip-remove", "chips", "clear", "collection", "content", "empty", "group", "item", "item-indicator", "label", "list", "separator", "trigger", "trigger-icon", "value"],
  command: ["", "empty", "group", "input", "input-wrapper", "item", "list", "separator", "shortcut"],
  "context-menu": ["", "checkbox-item", "content", "group", "item", "label", "portal", "radio-group", "radio-item", "separator", "shortcut", "sub", "sub-content", "sub-trigger", "trigger"],
  dialog: ["", "close", "content", "description", "footer", "header", "overlay", "portal", "title", "trigger"],
  drawer: ["", "close", "content", "description", "footer", "header", "overlay", "popup", "portal", "swipe-handle", "title", "trigger", "viewport"],
  "dropdown-menu": ["", "checkbox-item", "checkbox-item-indicator", "content", "group", "item", "label", "portal", "radio-group", "radio-item", "radio-item-indicator", "separator", "shortcut", "sub", "sub-content", "sub-trigger", "trigger"],
  empty: ["", "content", "description", "header", "icon", "title"],
  field: ["", "content", "description", "error", "group", "label", "legend", "separator", "separator-content", "set"],
  form: ["control", "description", "item", "label", "message"],
  "hover-card": ["", "content", "portal", "trigger"],
  input: [""],
  "input-group": ["", "addon", "button", "control"],
  "input-otp": ["", "group", "separator", "slot"],
  item: ["", "actions", "content", "description", "footer", "group", "header", "media", "separator", "title"],
  kbd: ["", "group"],
  label: [""],
  marker: ["", "content", "icon"],
  menubar: ["", "checkbox-item", "content", "group", "item", "label", "menu", "portal", "radio-group", "radio-item", "separator", "shortcut", "sub", "sub-content", "sub-trigger", "trigger"],
  message: ["", "avatar", "content", "footer", "group", "header"],
  "message-scroller": ["", "button", "content", "item", "viewport"],
  "native-select": ["", "icon", "optgroup", "option", "wrapper"],
  "navigation-menu": ["", "content", "indicator", "item", "link", "list", "trigger", "viewport"],
  pagination: ["", "content", "ellipsis", "item", "link", "next", "previous"],
  popover: ["", "anchor", "content", "description", "header", "title", "trigger"],
  progress: ["", "indicator", "label", "track", "value"],
  questionnaire: ["", "actions", "choice", "choice-description", "choice-indicator", "choice-indicator-check", "choice-indicator-dot", "choice-input", "choice-label", "choice-shortcut", "choices", "description", "error", "input", "input-wrapper", "item", "next", "previous", "progress", "skip", "submit", "title"],
  "radio-group": ["", "indicator", "item"],
  resizable: ["handle", "panel", "panel-group"],
  "scroll-area": ["", "scrollbar", "thumb", "viewport"],
  select: ["", "content", "empty", "group", "input", "input-wrapper", "item", "item-indicator", "label", "list", "scroll-down-button", "scroll-up-button", "separator", "trigger", "value"],
  separator: [""],
  sheet: ["", "close", "content", "description", "footer", "header", "overlay", "portal", "title", "trigger"],
  sidebar: ["", "container", "content", "footer", "gap", "group", "group-action", "group-content", "group-label", "header", "inner", "input", "inset", "menu", "menu-action", "menu-badge", "menu-button", "menu-item", "menu-skeleton", "menu-sub", "menu-sub-button", "menu-sub-item", "rail", "separator", "trigger", "wrapper"],
  skeleton: [""],
  slider: ["", "range", "thumb", "track"],
  spinner: [""],
  switch: ["", "thumb"],
  table: ["", "body", "caption", "cell", "container", "footer", "head", "header", "row"],
  tabs: ["", "content", "list", "trigger"],
  textarea: [""],
  toast: ["", "action", "close", "content", "description", "icon", "portal", "title", "viewport"],
  toggle: [""],
  "toggle-group": ["", "item"],
  tooltip: ["", "content", "provider", "trigger"],
};

export const SHADCN_SLOTS: ReadonlySet<string> = new Set(Object.entries(SHADCN_PARTS).flatMap(([base, parts]) => parts.map((part) => (part ? `${base}-${part}` : base))));

const slot = (...names: string[]): string => names.map((n) => `[data-slot="${n}"]`).join(", ");

export const LIBRARIES: readonly LibraryFingerprint[] = [
  {
    id: "mui",
    name: "MUI",
    layer: 2,
    packages: ["@mui/material", "@mui/joy", "@mui/lab", "@material-ui/core"],
    classPattern: { source: "^Mui[A-Z][A-Za-z]*-", label: "Mui* classes", strength: "strong" },
    cssVarPrefixes: [{ prefix: "--mui-", strength: "strong" }],
    elements: byClass({
      button: ".MuiButton-root, .MuiIconButton-root",
      input: ".MuiInputBase-root",
      checkbox: ".MuiCheckbox-root",
      switch: ".MuiSwitch-root",
      select: ".MuiSelect-select",
      tabs: ".MuiTabs-root",
      dialog: ".MuiDialog-paper",
      menu: ".MuiMenu-paper",
      popover: ".MuiPopover-paper:not(.MuiMenu-paper)",
      tooltip: ".MuiTooltip-tooltip",
      accordion: ".MuiAccordion-root",
      card: ".MuiCard-root",
      avatar: ".MuiAvatar-root",
      badge: ".MuiChip-root, .MuiBadge-badge",
    }),
  },
  {
    id: "shadcn",
    name: "shadcn/ui",
    layer: 2,
    // shadcn/ui is copied into the repo, not installed: components.json and data-slot usage find it.
    packages: [],
    elements: byClass({
      button: slot("button"),
      input: slot("input", "textarea", "input-group-control"),
      checkbox: slot("checkbox"),
      switch: slot("switch"),
      select: slot("select-trigger", "native-select"),
      tabs: slot("tabs"),
      dialog: slot("dialog-content", "alert-dialog-content", "sheet-content", "drawer-content", "drawer-popup"),
      menu: slot("dropdown-menu-content", "context-menu-content", "menubar-content"),
      popover: slot("popover-content", "hover-card-content"),
      tooltip: slot("tooltip-content"),
      accordion: slot("accordion"),
      card: slot("card"),
      avatar: slot("avatar"),
      badge: slot("badge"),
    }),
  },
  {
    id: "radix-themes",
    name: "Radix Themes",
    layer: 2,
    packages: ["@radix-ui/themes"],
    classPattern: { source: "^rt-[A-Z]", label: "rt-* classes", strength: "strong" },
    elements: byClass({
      button: ".rt-Button, .rt-IconButton",
      input: ".rt-TextFieldRoot, .rt-TextAreaRoot",
      checkbox: ".rt-CheckboxRoot",
      switch: ".rt-SwitchRoot",
      select: ".rt-SelectTrigger",
      tabs: ".rt-TabsList",
      dialog: ".rt-DialogContent, .rt-AlertDialogContent",
      menu: ".rt-DropdownMenuContent",
      popover: ".rt-PopoverContent",
      tooltip: ".rt-TooltipContent",
      card: ".rt-Card",
      avatar: ".rt-AvatarRoot",
      badge: ".rt-Badge",
    }),
  },
  {
    id: "chakra",
    name: "Chakra UI",
    layer: 2,
    packages: ["@chakra-ui/react"],
    classPattern: { source: "^chakra-", label: "chakra-* classes", strength: "strong" },
    cssVarPrefixes: [{ prefix: "--chakra-", strength: "strong" }],
    elements: byClass({
      button: ".chakra-button",
      input: ".chakra-input",
      checkbox: ".chakra-checkbox",
      switch: ".chakra-switch",
      select: ".chakra-select",
      tabs: ".chakra-tabs",
      dialog: ".chakra-modal__content, .chakra-dialog__content",
      menu: ".chakra-menu__menu-list, .chakra-menu__content",
      popover: ".chakra-popover__content",
      tooltip: ".chakra-tooltip",
      accordion: ".chakra-accordion",
      card: ".chakra-card",
      avatar: ".chakra-avatar",
      badge: ".chakra-badge",
    }),
  },
  {
    id: "mantine",
    name: "Mantine",
    layer: 2,
    packages: ["@mantine/core"],
    classPattern: { source: "^mantine-", label: "mantine-* classes", strength: "strong" },
    cssVarPrefixes: [{ prefix: "--mantine-", strength: "strong" }],
    elements: byClass({
      button: ".mantine-Button-root, .mantine-ActionIcon-root",
      input: ".mantine-Input-input",
      checkbox: ".mantine-Checkbox-root",
      switch: ".mantine-Switch-root",
      select: ".mantine-Select-root",
      tabs: ".mantine-Tabs-root",
      dialog: ".mantine-Modal-content",
      menu: ".mantine-Menu-dropdown",
      popover: ".mantine-Popover-dropdown",
      tooltip: ".mantine-Tooltip-tooltip",
      accordion: ".mantine-Accordion-root",
      card: ".mantine-Card-root",
      avatar: ".mantine-Avatar-root",
      badge: ".mantine-Badge-root",
    }),
  },
  {
    id: "antd",
    name: "Ant Design",
    layer: 2,
    packages: ["antd"],
    classPattern: { source: "^ant-", label: "ant-* classes", strength: "strong" },
    elements: byClass({
      button: ".ant-btn",
      input: ".ant-input",
      checkbox: ".ant-checkbox-wrapper",
      switch: ".ant-switch",
      select: ".ant-select",
      tabs: ".ant-tabs",
      dialog: ".ant-modal-content",
      menu: ".ant-dropdown-menu",
      popover: ".ant-popover-inner",
      tooltip: ".ant-tooltip-inner",
      accordion: ".ant-collapse",
      card: ".ant-card",
      avatar: ".ant-avatar",
      badge: ".ant-tag, .ant-badge",
    }),
  },
  {
    id: "blueprint",
    name: "Blueprint",
    layer: 2,
    packages: ["@blueprintjs/core"],
    classPattern: { source: "^bp5-", label: "bp5-* classes", strength: "strong" },
    elements: byClass({
      button: ".bp5-button",
      input: ".bp5-input",
      checkbox: ".bp5-checkbox",
      switch: ".bp5-switch",
      select: ".bp5-html-select, .bp5-select",
      tabs: ".bp5-tabs",
      dialog: ".bp5-dialog",
      menu: ".bp5-menu",
      popover: ".bp5-popover-content",
      tooltip: ".bp5-tooltip",
      card: ".bp5-card",
      badge: ".bp5-tag",
    }),
  },
  {
    id: "geist",
    name: "Geist (Vercel)",
    layer: 2,
    packages: ["geist"],
    // Shared-looking prefixes: on their own they only ever give a low-confidence verdict.
    cssVarPrefixes: [
      { prefix: "--geist-", strength: "weak" },
      { prefix: "--ds-", strength: "weak" },
    ],
    elements: [],
  },
  {
    id: "radix",
    name: "Radix Primitives",
    layer: 1,
    packages: ["radix-ui"],
    packagePrefixes: ["@radix-ui/react-"],
    cssVarPrefixes: [{ prefix: "--radix-", strength: "strong" }],
    idPrefixes: ["radix-"],
    elements: byIdPrefix("radix-", {
      checkbox: '[role="checkbox"]',
      switch: '[role="switch"]',
      select: '[role="combobox"]',
      tabs: '[role="tablist"], [role="tab"]',
      dialog: '[role="dialog"], [role="alertdialog"]',
      menu: '[role="menu"]',
      tooltip: '[role="tooltip"]',
    }),
    packageElements: {
      "@radix-ui/react-checkbox": "checkbox",
      "@radix-ui/react-switch": "switch",
      "@radix-ui/react-select": "select",
      "@radix-ui/react-tabs": "tabs",
      "@radix-ui/react-dialog": "dialog",
      "@radix-ui/react-alert-dialog": "dialog",
      "@radix-ui/react-dropdown-menu": "menu",
      "@radix-ui/react-context-menu": "menu",
      "@radix-ui/react-popover": "popover",
      "@radix-ui/react-tooltip": "tooltip",
      "@radix-ui/react-accordion": "accordion",
      "@radix-ui/react-avatar": "avatar",
    },
  },
  {
    id: "base-ui",
    name: "Base UI",
    layer: 1,
    packages: ["@base-ui-components/react", "@base-ui/react"],
    idPrefixes: ["base-ui-"],
    elements: byIdPrefix("base-ui-", {
      input: "input",
      checkbox: '[role="checkbox"]',
      switch: '[role="switch"]',
      select: '[role="combobox"]',
      tabs: '[role="tablist"], [role="tab"]',
      dialog: '[role="dialog"], [role="alertdialog"]',
      menu: '[role="menu"]',
      tooltip: '[role="tooltip"]',
    }),
  },
  {
    id: "headlessui",
    name: "Headless UI",
    layer: 1,
    packages: ["@headlessui/react", "@headlessui/vue"],
    idPrefixes: ["headlessui-"],
    elements: byIdPrefix("headlessui-", {
      switch: '[role="switch"]',
      select: '[role="listbox"]',
      tabs: '[role="tab"]',
      dialog: '[role="dialog"]',
      menu: '[role="menu"]',
    }),
  },
  {
    id: "styled-components",
    name: "styled-components",
    layer: 0,
    packages: ["styled-components"],
    classPattern: { source: "^sc-[A-Za-z0-9]{4,}$", label: "sc-* classes", strength: "strong" },
    styleTags: ["data-styled"],
    elements: styled({ button: "button", input: "input", dialog: '[role="dialog"]', card: "article" }),
  },
  {
    id: "emotion",
    name: "Emotion",
    layer: 0,
    packages: ["@emotion/react", "@emotion/styled"],
    styleTags: ["data-emotion"],
    elements: [],
  },
];

export const LIBRARY_BY_ID: ReadonlyMap<string, LibraryFingerprint> = new Map(LIBRARIES.map((l) => [l.id, l]));

/** The library an npm package belongs to, if any. */
export function libraryOfPackage(name: string): LibraryFingerprint | undefined {
  return LIBRARIES.find((l) => l.packages.includes(name) || l.packagePrefixes?.some((p) => name.startsWith(p)));
}

/**
 * Signals that never decide a verdict, only support one that something else decided: a Radix
 * Colors scale (Radix Themes ships them, and shadcn themes often borrow them) and dense Tailwind
 * utilities (shadcn and Headless UI are styled with Tailwind; so are countless sites with neither).
 */
export const SUPPORT = {
  "radix-colors": ["radix-themes", "radix", "shadcn"],
  tailwind: ["shadcn", "headlessui", "base-ui", "radix"],
} as const satisfies Record<string, readonly string[]>;

/** Twelve steps of a Radix Colors scale on :root: `--gray-1` … `--gray-12` (or the alpha `--gray-a1` …). */
export const RADIX_SCALE = /^--([a-z]+)-(a?)(\d{1,2})$/;

/** A Tailwind utility class token (variants allowed). Density is the share of class tokens that match. */
export const TAILWIND_UTILITY =
  "^(?:[a-z0-9-]+:)*!?-?(?:p[xytrblse]?|m[xytrblse]?|w|h|size|min-w|min-h|max-w|max-h|gap(?:-[xy])?|space-[xy]|text|bg|border(?:-[xytrbl])?|rounded(?:-[a-z]+)?|shadow|ring|font|leading|tracking|items|justify|self|place|grid-cols|col-span|row-span|inset|top|right|bottom|left|z|opacity|translate-[xy]|duration|ease|outline|fill|stroke)-[^\\s]+$|^(?:[a-z0-9-]+:)*(?:flex|inline-flex|grid|block|inline-block|hidden|relative|absolute|fixed|sticky|truncate|uppercase|underline|shrink-0|grow|flex-1|flex-col|flex-row|flex-wrap|transition|transition-colors|sr-only|overflow-hidden|cursor-pointer|select-none|whitespace-nowrap)$";

/** At least this share of class tokens, out of at least TAILWIND_MIN_TOKENS, counts as Tailwind-dense. */
export const TAILWIND_DENSITY = 0.35;
export const TAILWIND_MIN_TOKENS = 20;

/** Named imports → element types, for kits that export one component per element. */
export const EXPORT_TYPES: Readonly<Record<string, DetectElementType>> = {
  Button: "button",
  IconButton: "button",
  ActionIcon: "button",
  TextField: "input",
  TextInput: "input",
  Input: "input",
  Textarea: "input",
  Checkbox: "checkbox",
  Switch: "switch",
  Select: "select",
  NativeSelect: "select",
  Tabs: "tabs",
  Tab: "tabs",
  Dialog: "dialog",
  Modal: "dialog",
  AlertDialog: "dialog",
  Drawer: "dialog",
  Menu: "menu",
  DropdownMenu: "menu",
  Dropdown: "menu",
  Popover: "popover",
  Tooltip: "tooltip",
  Accordion: "accordion",
  Collapse: "accordion",
  Card: "card",
  Avatar: "avatar",
  Badge: "badge",
  Chip: "badge",
  Tag: "badge",
};

/** shadcn component files (components/ui/<name>) → element types. */
export const SHADCN_FILE_TYPES: Readonly<Record<string, DetectElementType>> = {
  button: "button",
  input: "input",
  textarea: "input",
  "input-group": "input",
  checkbox: "checkbox",
  switch: "switch",
  select: "select",
  "native-select": "select",
  combobox: "select",
  tabs: "tabs",
  dialog: "dialog",
  "alert-dialog": "dialog",
  sheet: "dialog",
  drawer: "dialog",
  "dropdown-menu": "menu",
  "context-menu": "menu",
  menubar: "menu",
  popover: "popover",
  "hover-card": "popover",
  tooltip: "tooltip",
  accordion: "accordion",
  card: "card",
  avatar: "avatar",
  badge: "badge",
};
