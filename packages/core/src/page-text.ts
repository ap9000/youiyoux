/**
 * Text a probed page supplies (its accessible names, attribute values, roles, component names,
 * addresses, a browser error's words) reaches what youiyoux says: results' why, fix and info,
 * refusals, terminal and CI lines, and the agents and change requests that read them. A page is
 * untrusted input, so none of it is ever echoed raw:
 *
 * - ARIA attribute values and roles are quoted only when they are from a closed, known set; any
 *   other value is "an unexpected value" (or "an element"), never echoed.
 * - Free text (names, a URL's path) loses control and direction characters and line breaks, has
 *   its whitespace collapsed, is capped with an ellipsis, and is quoted, so it can't start a line,
 *   pose as youiyoux's own words, or carry a terminal escape.
 *
 * Browser-safe (no Node imports).
 */

/** ARIA values a probe quotes: tokens of aria-expanded, aria-haspopup, aria-modal, aria-orientation and friends. */
const ARIA_VALUES: ReadonlySet<string> = new Set(["true", "false", "mixed", "undefined", "menu", "listbox", "dialog", "grid", "tree", "horizontal", "vertical", "page", "step", "location", "date", "time"]);

/** Roles (and, for an element without one, tags) a probe names. */
const KNOWN_ROLES: ReadonlySet<string> = new Set([
  "alert", "alertdialog", "application", "article", "banner", "button", "cell", "checkbox", "columnheader", "combobox", "complementary", "contentinfo", "definition", "dialog", "directory", "document", "feed", "figure", "form", "grid", "gridcell", "group", "heading", "img", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none", "note", "option", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem", "popover",
  // Tags, for an element without a role.
  "a", "aside", "body", "div", "footer", "header", "input", "label", "li", "nav", "ol", "p", "section", "select", "span", "summary", "details", "textarea", "ul", "iframe", "img", "svg", "video", "audio", "form", "html",
]);

/** Every Unicode control (Cc), format (Cf: direction marks and overrides, zero-width, soft hyphen, Arabic letter mark), line and paragraph separator (Zl, Zp) and default-ignorable character (combining grapheme joiner, Hangul fillers, variation selectors). */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
/** `value` with control and direction characters dropped, whitespace collapsed, and at most `max` characters (an ellipsis past it). Unquoted. */
export function cleanText(value: unknown, max = 200): string {
  const text = String(value ?? "").replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

/** Free text from a page, for a sentence: cleaned, capped at `max`, in single quotes (a quote inside becomes ’); empty is "(no name)". */
export function pageText(value: unknown, max = 60): string {
  const text = cleanText(value, max).replace(/'/g, "’");
  return text ? `'${text}'` : "(no name)";
}

/** An ARIA attribute value from a page: quoted when it is a known token, else "an unexpected value". */
export function ariaToken(value: string | null | undefined): string {
  return typeof value === "string" && ARIA_VALUES.has(value) ? `"${value}"` : "an unexpected value";
}

/** A role (or tag) from a page: itself when it is a known one, else "element". */
export function roleWord(role: string | null | undefined): string {
  return typeof role === "string" && KNOWN_ROLES.has(role) ? role : "element";
}
