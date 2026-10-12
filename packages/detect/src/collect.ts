/**
 * The in-page half of website detection: one function, run in the page with page.evaluate,
 * that reads every fingerprint at once and marks the first visible element per element rule
 * so it can be screenshotted. It is kept as JavaScript source text, so it runs exactly as
 * written in the browser (no transpiler helpers, no Node globals).
 */
import type { DetectElementType } from "@youiyoux/core";
import { LIBRARIES, TAILWIND_UTILITY } from "./fingerprints.ts";
import type { Tally } from "./site-signals.ts";

export interface CollectSpec {
  /** Elements matched by rule `i` get the attribute `${marker}${i}`. */
  readonly marker: string;
  readonly classPatterns: ReadonlyArray<{ readonly library: string; readonly source: string }>;
  readonly idPrefixes: readonly string[];
  readonly styleTags: readonly string[];
  readonly tailwind: string;
  readonly elements: ReadonlyArray<{ readonly library: string; readonly type: DetectElementType; readonly selector: string }>;
}

export interface CollectedFacts {
  readonly title: string;
  readonly classes: Record<string, Tally>;
  readonly rootVars: string[];
  readonly ids: Record<string, Tally>;
  readonly dataSlots: Record<string, number>;
  readonly styleTags: Record<string, number>;
  readonly tailwind: { utility: number; total: number };
  readonly fonts: Array<{ family: string; usedBy: string[] }>;
  /** Per element rule, in spec order: how many matched, and whether a visible one was marked. */
  readonly elements: Array<{ count: number; marked: boolean }>;
}

export const MARKER = "data-youi-detect-";

export function collectSpec(): CollectSpec {
  return {
    marker: MARKER,
    classPatterns: LIBRARIES.flatMap((l) => (l.classPattern ? [{ library: l.id, source: l.classPattern.source }] : [])),
    idPrefixes: LIBRARIES.flatMap((l) => l.idPrefixes ?? []),
    styleTags: LIBRARIES.flatMap((l) => l.styleTags ?? []),
    tailwind: TAILWIND_UTILITY,
    elements: LIBRARIES.flatMap((l) => l.elements.map((e) => ({ library: l.id, type: e.type, selector: e.selector }))),
  };
}

/** `(spec) => CollectedFacts`, as source. */
export const COLLECT_SOURCE = String.raw`(spec) => {
  const tally = (map, key, sample) => {
    const t = map[key] || (map[key] = { count: 0, samples: [] });
    t.count++;
    if (sample && t.samples.length < 5 && !t.samples.includes(sample)) t.samples.push(sample);
  };
  const all = Array.from(document.querySelectorAll("*"));
  const patterns = spec.classPatterns.map((p) => ({ library: p.library, re: new RegExp(p.source) }));
  const utility = new RegExp(spec.tailwind);
  const classes = {};
  const ids = {};
  const dataSlots = {};
  let tokens = 0;
  let utilities = 0;
  for (const el of all) {
    const list = el.classList ? Array.from(el.classList) : [];
    for (const token of list) {
      tokens++;
      if (utility.test(token)) utilities++;
      for (const p of patterns) if (p.re.test(token)) tally(classes, p.library, token);
    }
    if (el.id) for (const prefix of spec.idPrefixes) if (el.id.startsWith(prefix)) tally(ids, prefix, el.id);
    const slot = el.getAttribute("data-slot");
    if (slot) dataSlots[slot] = (dataSlots[slot] || 0) + 1;
  }

  // Custom properties declared on :root or html: computed style, inline style and every readable rule.
  const vars = new Set();
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  for (let i = 0; i < computed.length; i++) if (computed[i].startsWith("--")) vars.add(computed[i]);
  for (let i = 0; i < root.style.length; i++) if (root.style[i].startsWith("--")) vars.add(root.style[i]);
  const rootSelector = /(^|,)\s*(:root|html)(?![\w-])/;
  const walk = (rules) => {
    for (const rule of Array.from(rules || [])) {
      if (rule.selectorText && rootSelector.test(rule.selectorText)) for (let i = 0; i < rule.style.length; i++) if (rule.style[i].startsWith("--")) vars.add(rule.style[i]);
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { walk(sheet.cssRules); } catch (_) { /* a cross-origin sheet cannot be read */ }
  }

  const styleTags = {};
  for (const attr of spec.styleTags) {
    const n = document.querySelectorAll("style[" + attr + "]").length;
    if (n > 0) styleTags[attr] = n;
  }

  const fonts = {};
  for (const selector of ["body", "h1", "h2", "button", "input", "code"]) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const family = getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (family) (fonts[family] || (fonts[family] = [])).push(selector);
  }

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
  const elements = spec.elements.map((rule, i) => {
    const attr = spec.marker + i;
    for (const old of Array.from(document.querySelectorAll("[" + attr + "]"))) old.removeAttribute(attr);
    let matches = [];
    try { matches = Array.from(document.querySelectorAll(rule.selector)); } catch (_) { matches = []; }
    const shown = matches.find(visible);
    if (shown) shown.setAttribute(attr, "");
    return { count: matches.length, marked: Boolean(shown) };
  });

  return {
    title: document.title,
    classes,
    rootVars: Array.from(vars).sort(),
    ids,
    dataSlots,
    styleTags,
    tailwind: { utility: utilities, total: tokens },
    fonts: Object.entries(fonts).map(([family, usedBy]) => ({ family, usedBy })),
    elements,
  };
}`;

/** Triggers worth opening to expose portals: menus, dialogs, popovers and unselected tabs. */
export const TRIGGERS_SOURCE = String.raw`({ attr, limit }) => {
  const selectors = ['[aria-haspopup]:not([aria-haspopup="false"]):not([aria-expanded="true"])', '[aria-expanded="false"][aria-controls]', '[role="tab"][aria-selected="false"]', '[data-slot$="-trigger"]:not([data-state="open"]):not([data-state="active"])'];
  const found = [];
  for (const el of Array.from(document.querySelectorAll(selectors.join(", ")))) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || el.closest("a[href]") || el.hasAttribute("disabled")) continue;
    if (found.length >= limit) break;
    el.setAttribute(attr, String(found.length));
    found.push(el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 40) || el.tagName.toLowerCase());
  }
  return found;
}`;
