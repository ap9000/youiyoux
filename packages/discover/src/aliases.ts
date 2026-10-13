/**
 * What people call the same thing. A need ("command menu") is read as concepts: each
 * concept has the names it goes by and the npm packages that are built for it, so a
 * cmdk-based item matches "command palette" though it never says so.
 */
export interface Concept {
  readonly id: string;
  /** Phrases that name it, lowercase; the first is how npm is searched for it. */
  readonly names: readonly string[];
  /** Packages an item depends on when it is one of these. */
  readonly packages: readonly string[];
}

export const CONCEPTS: readonly Concept[] = [
  { id: "command", names: ["command palette", "command menu", "command", "cmdk", "kbar", "quick open"], packages: ["cmdk", "kbar", "@udecode/cmdk"] },
  { id: "toast", names: ["toast", "notification", "snackbar", "toaster", "sonner"], packages: ["sonner", "react-hot-toast", "react-toastify", "notistack"] },
  { id: "date-picker", names: ["date picker", "datepicker", "calendar", "date range picker", "day picker", "date input"], packages: ["react-day-picker", "react-datepicker"] },
  { id: "combobox", names: ["combobox", "autocomplete", "typeahead", "searchable select", "multi select", "multiselect"], packages: ["downshift", "react-select"] },
  { id: "dialog", names: ["dialog", "modal", "alert dialog", "lightbox"], packages: [] },
  { id: "drawer", names: ["drawer", "sheet", "bottom sheet", "side panel", "off canvas"], packages: ["vaul"] },
  { id: "menu", names: ["dropdown menu", "context menu", "menubar", "dropdown", "menu"], packages: [] },
  { id: "popover", names: ["popover", "hover card", "popup", "flyout"], packages: [] },
  { id: "tooltip", names: ["tooltip", "hint"], packages: [] },
  { id: "tabs", names: ["tabs", "tab bar", "segmented control", "segment group"], packages: [] },
  { id: "button", names: ["button", "icon button", "cta"], packages: [] },
  { id: "input", names: ["input", "text field", "textfield", "text input", "textarea"], packages: [] },
  { id: "card", names: ["card", "tile"], packages: [] },
  { id: "badge", names: ["badge", "tag", "chip", "pill"], packages: [] },
  { id: "avatar", names: ["avatar", "profile picture"], packages: [] },
  { id: "accordion", names: ["accordion", "collapsible", "disclosure", "expander"], packages: [] },
  { id: "table", names: ["data table", "data grid", "table", "datagrid"], packages: ["@tanstack/react-table", "ag-grid-react"] },
  { id: "carousel", names: ["carousel", "slideshow", "image slider"], packages: ["embla-carousel-react", "swiper"] },
  { id: "slider", names: ["slider", "range slider", "range"], packages: [] },
  { id: "switch", names: ["switch", "toggle"], packages: [] },
  { id: "checkbox", names: ["checkbox", "check box"], packages: [] },
  { id: "radio", names: ["radio group", "radio"], packages: [] },
  { id: "select", names: ["select", "picker", "listbox"], packages: [] },
  { id: "otp", names: ["otp", "one time password", "pin input", "otp field", "verification code"], packages: ["input-otp"] },
  { id: "progress", names: ["progress", "progress bar", "meter"], packages: [] },
  { id: "spinner", names: ["spinner", "loader", "loading"], packages: [] },
  { id: "skeleton", names: ["skeleton", "shimmer"], packages: [] },
  { id: "file-upload", names: ["file upload", "dropzone", "uploader", "file input", "drop zone"], packages: ["react-dropzone"] },
  { id: "color-picker", names: ["color picker", "colour picker", "color input"], packages: ["react-colorful"] },
  { id: "rating", names: ["rating", "star rating"], packages: [] },
  { id: "stepper", names: ["stepper", "steps", "wizard", "multi step"], packages: [] },
  { id: "tree", names: ["tree view", "tree", "file tree"], packages: [] },
  { id: "kanban", names: ["kanban", "kanban board", "drag and drop"], packages: ["@dnd-kit/core", "@hello-pangea/dnd"] },
  { id: "chart", names: ["chart", "graph", "plot", "charts"], packages: ["recharts", "@visx/visx", "chart.js"] },
  { id: "sidebar", names: ["sidebar", "side nav", "side navigation"], packages: [] },
  { id: "navigation", names: ["navigation menu", "navbar", "nav bar", "navigation"], packages: [] },
  { id: "breadcrumb", names: ["breadcrumb", "breadcrumbs"], packages: [] },
  { id: "pagination", names: ["pagination", "pager"], packages: [] },
  { id: "editor", names: ["rich text editor", "rich text", "wysiwyg", "editor"], packages: ["@tiptap/react", "lexical", "slate", "@lexical/react"] },
  { id: "code-block", names: ["code block", "syntax highlighting", "code snippet"], packages: ["shiki", "prismjs", "react-syntax-highlighter"] },
  { id: "tags-input", names: ["tags input", "tag input", "token field", "chips input"], packages: [] },
  { id: "marquee", names: ["marquee", "ticker", "scrolling text"], packages: [] },
];

const BY_ID = new Map(CONCEPTS.map((c) => [c.id, c]));

export function conceptById(id: string): Concept | undefined {
  return BY_ID.get(id);
}

/** Lowercase words: kebab, snake and camel case split, punctuation dropped (`DatePicker` → `date picker`). */
export function normalize(text: string): string {
  return text.normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `phrase` occurs in `text` as whole words (both already normalized). */
export function hasPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

export interface ReadNeed {
  readonly concepts: readonly Concept[];
  /** Words no concept explained, matched as plain text. */
  readonly words: readonly string[];
}

const STOP = new Set(["a", "an", "the", "for", "with", "and", "or", "of", "to", "in", "component", "components", "ui", "react"]);

/**
 * Read a need as concepts, longest phrase first, so "dropdown menu" is one concept and not
 * two; whatever is left is plain words. "command menu" → command.
 */
export function readNeed(need: string): ReadNeed {
  let rest = normalize(need);
  const found: Concept[] = [];
  const phrases = CONCEPTS.flatMap((concept) => concept.names.map((name) => ({ concept, name: normalize(name) }))).sort((a, b) => b.name.length - a.name.length);
  for (const { concept, name } of phrases) {
    if (!hasPhrase(rest, name)) continue;
    if (!found.includes(concept)) found.push(concept);
    rest = ` ${rest} `.replace(` ${name} `, " ").trim();
  }
  return { concepts: found, words: rest.split(" ").filter((w) => w.length > 1 && !STOP.has(w)) };
}

/** The concept a role names (`button`, `dialog`, `toast`…), by id or by any of its names. */
export function conceptForRole(role: string): Concept | undefined {
  const n = normalize(role);
  return BY_ID.get(n.replace(/ /g, "-")) ?? CONCEPTS.find((c) => c.names.some((name) => normalize(name) === n));
}
