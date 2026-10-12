/**
 * "Try it": one component look bundled for the browser, so the hub can make that look's tile live
 * (Radix tabs switch, a dialog opens and closes, a JS-driven tab pill moves). Built on request by
 * the hub's own server, never at snapshot time and never for a look nobody clicked.
 *
 * The same fence as the server render (render.ts): the recipe's files must be inside the project
 * root, every import esbuild resolves must be inside the root or a package in the root's own
 * node_modules (contain.ts), the tsconfig and its `extends` too, and esbuild is cancelled after its
 * time limit. A refusal, a timeout or a module that does not bundle is returned as a sentence,
 * never thrown. Unlike the server render the bundle keeps Radix's real portal, since a browser has
 * a body to portal into. Nothing is written: esbuild's output stays in memory.
 *
 * The bundle is a classic script (an IIFE) for a sandboxed frame without same-origin access: it
 * renders the look (with its sibling looks, so a tab trigger has others to switch to) inside its
 * wrappers into `#youi-specimen`, replacing the static HTML there, and talks to the hub only by
 * `postMessage`: the box its elements cover (so the hub can fit it in the tile), an Escape the
 * look did not use itself, and an error when it fails to load or render. A wrapper or look whose
 * recipe holds `open: true` (a dialog drawn open) is controlled by the bootstrap: it closes as the
 * site's would, and an "Open again" button brings it back.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { limitOf } from "./css.ts";
import { packageUnderRoot, realOf, relativeInside } from "./contain.ts";
import { ASSET_LOADERS, BUNDLE_TIMEOUT_MS, bundleError, bundleWithin, checkedTsconfig, containment, ICON_PATH, stubs, type ComponentRecipe } from "./render.ts";

/** One look as the bundle renders it. */
export interface BrowserLook {
  readonly recipe: ComponentRecipe;
  /** Its children when the site has none of its own. */
  readonly label: string | null;
  readonly icon?: boolean;
}

/** A file the bundle read, by its content, so a cached bundle is reused only while every input is unchanged. */
export interface BundleInput {
  readonly path: string;
  readonly digest: string;
}

export interface BrowserBundle {
  /** The code's content hash: the name it is served under. */
  readonly hash: string;
  readonly code: string;
  readonly inputs: readonly BundleInput[];
}

export type BrowserResult = BrowserBundle | { readonly error: string };

/** What the frame posts to the hub; every message carries `youi: "try"`. */
export type TryMessage = { youi: "try"; type: "box"; x: number; y: number; width: number; height: number } | { youi: "try"; type: "escape" } | { youi: "try"; type: "ready" } | { youi: "try"; type: "error"; message: string };

/** The entry's name in esbuild's output (it is never on disk). */
const ENTRY = "youi-try.js";

/** The siblings a look renders with, at most. */
export const MAX_SIBLINGS = 6;

const digestOf = (path: string): string | null => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

/**
 * The bootstrap, after the entry has defined `React`, `createRoot`, `modules`, `LOOKS` and
 * `WRAPPERS`. Plain JavaScript; it posts only geometry, Escape and error text.
 */
const BOOTSTRAP = `
const post = (message) => { try { parent.postMessage(Object.assign({ youi: "try" }, message), "*"); } catch (error) {} };
const exported = (file, name) => {
  const module = modules[file];
  const value = module && (name === "default" ? module.default : module[name]);
  if (value === undefined || value === null) throw new Error(file + " has no export " + name);
  return value;
};
const icon = () => React.createElement("svg", { xmlns: "http://www.w3.org/2000/svg", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, React.createElement("path", { d: ${JSON.stringify(ICON_PATH)} }));
const opensItself = (props) => Boolean(props && props.open === true);
const measure = (() => {
  let pending = 0;
  return () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const element of document.body.querySelectorAll("*")) {
        if (element.tagName === "SCRIPT") continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        left = Math.min(left, rect.left); top = Math.min(top, rect.top); right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
      }
      if (Number.isFinite(left)) post({ type: "box", x: left, y: top, width: right - left, height: bottom - top });
    });
  };
})();
function Live() {
  const [open, setOpen] = React.useState(true);
  const control = (props) => (opensItself(props) ? Object.assign({}, props, { open, onOpenChange: (value) => setOpen(Boolean(value)) }) : props);
  React.useEffect(() => {
    window.__youiReady = true;
    post({ type: "ready" });
    measure();
  }, []);
  React.useEffect(measure, [open]);
  const children = LOOKS.map((look, i) => React.createElement(exported(look.file, look.export), Object.assign({ key: i }, control(look.props)), ...(look.icon ? [icon()] : look.label === null ? [] : [look.label])));
  let element = children.length === 1 ? children[0] : React.createElement(React.Fragment, null, ...children);
  for (const wrapper of WRAPPERS.slice().reverse()) element = React.createElement(exported(wrapper.file, wrapper.export), control(wrapper.props), element);
  const controlled = LOOKS.concat(WRAPPERS).some((part) => opensItself(part.props));
  return React.createElement(React.Fragment, null, element, controlled && !open ? React.createElement("button", { type: "button", "data-youi-reopen": "", onClick: () => setOpen(true), style: { font: "inherit", padding: "6px 12px", border: "1px solid currentColor", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer" } }, "Open again") : null);
}
class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { post({ type: "error", message: String((error && error.message) || error).split("\\n")[0] }); }
  render() { return this.state.failed ? null : this.props.children; }
}
const container = document.getElementById("youi-specimen");
new MutationObserver(measure).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
if (typeof ResizeObserver !== "undefined") new ResizeObserver(measure).observe(document.body);
if (document.fonts) document.fonts.ready.then(measure, measure);
// Escape the look did not use itself (Radix prevents the default when it closes a layer) ends Try it.
addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.defaultPrevented) post({ type: "escape" }); });
// The hub moves focus in: to the look's first control.
addEventListener("message", (event) => {
  if (event.source !== parent || !event.data || event.data.youi !== "try-focus") return;
  const first = container.querySelector('button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
  if (first) first.focus();
});
createRoot(container).render(React.createElement(Boundary, null, React.createElement(Live)));
`;

/** Until the look has rendered, an error anywhere (a module that throws as it loads) is reported. */
const BANNER = `addEventListener("error", function (event) { if (!window.__youiReady) try { parent.postMessage({ youi: "try", type: "error", message: String(event.message || "the look's code failed to load").split("\\n")[0] }, "*"); } catch (error) {} });`;

/**
 * Bundle a look (with its siblings, in line order; the look itself among them) for the browser,
 * from the project's own code and node_modules, fenced to its root. Resolves to the bundle or a
 * sentence saying why there is none.
 */
export async function bundleForBrowser(root: string, tsconfig: string, job: BrowserLook, siblings: readonly BrowserLook[] = [], options: { readonly bundleTimeoutMs?: number } = {}): Promise<BrowserResult> {
  try {
    if (!packageUnderRoot(root, "react") || !packageUnderRoot(root, "react-dom")) return { error: "react and react-dom are not installed in the project's node_modules" };
    const looks = siblings.length > 0 ? siblings.slice(0, MAX_SIBLINGS) : [job];
    const wrappers = job.recipe.wrappers;
    // A recipe file outside the root is never bundled.
    const relative = new Map<string, string>();
    for (const file of [...looks.map((l) => l.recipe.file), ...wrappers.map((w) => w.file)]) {
      const checked = relativeInside(root, file);
      if ("refused" in checked) return { error: `refused: ${checked.refused}` };
      relative.set(file, checked.ok);
    }
    const inside = (file: string): string => relative.get(file)!;
    const files = [...new Set(relative.values())];
    const config = checkedTsconfig(root, tsconfig);
    const refusals = new Set<string>();
    const entry = [
      `import * as React from "react";`,
      `import { createRoot } from "react-dom/client";`,
      ...files.map((file, i) => `import * as m${i} from ${JSON.stringify(`./${file}`)};`),
      `const modules = { ${files.map((file, i) => `${JSON.stringify(file)}: m${i}`).join(", ")} };`,
      `const LOOKS = ${JSON.stringify(looks.map((l) => ({ file: inside(l.recipe.file), export: l.recipe.export, props: l.recipe.props, label: l.label, icon: l.icon === true })))};`,
      `const WRAPPERS = ${JSON.stringify(wrappers.map((w) => ({ file: inside(w.file), export: w.export, props: w.props })))};`,
      BOOTSTRAP,
    ].join("\n");
    const timeoutMs = options.bundleTimeoutMs ?? BUNDLE_TIMEOUT_MS;
    let built: { text: string; inputs: string[] };
    try {
      built = await bundleWithin(
        {
          // The root's real path, so every input esbuild names resolves against it (a root under a symlinked /tmp).
          stdin: { contents: entry, resolveDir: realOf(root), loader: "js", sourcefile: ENTRY },
          absWorkingDir: realOf(root),
          bundle: true,
          metafile: true,
          platform: "browser",
          format: "iife",
          target: "es2020",
          minify: true,
          jsx: "automatic",
          banner: { js: BANNER },
          ...("path" in config && config.path ? { tsconfig: config.path } : { tsconfigRaw: {} }),
          define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
          loader: ASSET_LOADERS,
          logLevel: "silent",
          plugins: [stubs(root, { portal: false }), containment(root, refusals)],
        },
        timeoutMs,
      );
    } catch (error: unknown) {
      const message = bundleError(error);
      if (refusals.size > 0) return { error: [...refusals][0]! };
      if (message.startsWith("esbuild timed out")) return { error: `bundling took over ${limitOf(timeoutMs)} and was stopped` };
      return { error: `it did not bundle: ${message}` };
    }
    const inputs: BundleInput[] = [];
    const base = realOf(root);
    for (const input of built.inputs) {
      // Stubs and the entry live in esbuild's memory, not on disk.
      if (input === "<stdin>" || input === ENTRY || /^[\w-]+:/.test(input)) continue;
      const path = resolve(base, input);
      inputs.push({ path, digest: digestOf(path) ?? "missing" });
    }
    return { hash: createHash("sha256").update(built.text).digest("hex").slice(0, 16), code: built.text, inputs };
  } catch (error: unknown) {
    return { error: `it did not bundle: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
}

/**
 * Bundles kept in memory by a key (project and specimen): one is reused while every file it read
 * is unchanged; its code is served by its hash. One build per key is in flight at a time.
 */
export class BrowserBundleCache {
  private readonly byKey = new Map<string, BrowserBundle>();
  private readonly byHash = new Map<string, BrowserBundle>();
  private readonly building = new Map<string, Promise<BrowserResult>>();

  /** The cached bundle for `key` if its inputs are unchanged, else a fresh one from `build`. */
  async get(key: string, build: () => Promise<BrowserResult>): Promise<BrowserResult> {
    const cached = this.byKey.get(key);
    if (cached && cached.inputs.every((input) => digestOf(input.path) === input.digest)) return cached;
    const running = this.building.get(key);
    if (running) return running;
    const next = build().then((result) => {
      this.building.delete(key);
      if ("hash" in result) {
        this.byKey.set(key, result);
        this.byHash.set(result.hash, result);
      }
      return result;
    });
    this.building.set(key, next);
    return next;
  }

  /** A bundle's code by its hash, for serving. */
  code(hash: string): string | null {
    return this.byHash.get(hash)?.code ?? null;
  }
}
