/**
 * A Discover candidate bundled for the browser, in a project's setting: the files a person opened
 * (written by @youiyoux/discover's preparePreview into one preview directory) with the project's
 * React, tsconfig, utilities and components. Only bundled, never run here: esbuild reads the
 * files and writes nothing, and the output runs only in the hub's sandboxed frame (`allow-scripts`
 * without same origin), like Try it (client.ts).
 *
 * The fence of client.ts, widened by exactly that one directory. A module may come from the
 * preview directory, the project root, or an installed package; a bare import from the preview
 * resolves in the project's node_modules first, then in a fallback node_modules (the hub's own,
 * so a candidate built on cmdk still draws when the project has no cmdk), then in the packages
 * fetched for previews (`packages`: motion, say, fetched by @youiyoux/discover's
 * fetchPreviewPackages), each noted; a package in none of them is named in `missing`. React
 * always comes from the project, so there is one React. `cn` (shadcn's utility, as a package) is
 * the project's own `cn` when it has one, and `radix-ui` (the meta-package) is its primitives
 * from `@radix-ui/react-*` where those are installed; both are noted. Anything else that
 * resolves elsewhere, or not at all, is refused with a sentence naming it.
 *
 * A fetched file is held tighter than the project's own code: it may import code only (.ts,
 * .tsx, .js, .jsx, .mjs, .cjs, and .css, which loads empty) or a .json file of the preview's own
 * (a block's data), without import attributes, and only
 * when it lands, by real path, in the preview, one of the project's alias targets, or the
 * project's or the hub's installed packages. So it cannot inline the project's .env, JSON or
 * text files, or another folder's node_modules, into the bundle.
 *
 * What it renders: the item's main component built from its own exports (composeOf): a command
 * menu gets an input and a group of items, tabs get triggers and panels, a dialog opens, anything
 * else gets its title as its label. The bundle posts, by message, the same box, ready, escape and
 * error as Try it, and once it has drawn, its markup (`html`), which the hub draws statically in
 * its own CSS for the light, dark and state frames.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Plugin } from "esbuild";
import { sha256 } from "@youiyoux/core";
import { limitOf, tsconfigAliases } from "./css.ts";
import { inPackage, packageName, packageUnderRoot, realOf, within } from "./contain.ts";
import { ASSET_LOADERS, BUNDLE_TIMEOUT_MS, bundleError, bundleWithin, checkedTsconfig, ICON_PATH, stubs } from "./render.ts";
import type { BrowserResult, BundleInput } from "./client.ts";

/** One element of what the preview draws: an export of the item's main file, its props and children. */
export interface ComposeNode {
  readonly export: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: ReadonlyArray<ComposeNode | string>;
}

export interface PreviewJob {
  /** The project's root and tsconfig (project-relative). */
  readonly root: string;
  readonly tsconfig: string;
  /** The preview directory, and the item's main file relative to it. */
  readonly dir: string;
  readonly main: string;
  readonly compose: ComposeNode;
  /** A node_modules-holding directory to fall back to for packages the project lacks (the hub's). */
  readonly fallback?: string | null;
  /** The node_modules-holding directory of packages fetched for previews, tried after `fallback`. */
  readonly packages?: string | null;
  /** The project's own components the preview's imports were pointed at (absolute): fetched files may import exactly these too. */
  readonly projectParts?: readonly string[];
}

/** A bundle with what was substituted for it (packages from the hub, the project's cn), or why there is none. */
export type PreviewResult = (Extract<BrowserResult, { hash: string }> & { readonly notes: readonly string[] }) | { readonly error: string; readonly busy?: true; readonly missing?: readonly string[] };

const NAMESPACE = "youi-preview";
const GUARDED = "youiPreviewGuarded";
const ENTRY = "youi-preview.js";
/** What a fetched file may import: code, and stylesheets (which load empty: the project's sheet styles the preview). */
const PREVIEW_CODE = /\.(?:[cm]?[jt]sx?|css)$/i;

/** The `radix-ui` meta-package's parts, by the package each comes from. */
const RADIX_PARTS: Readonly<Record<string, string>> = {
  Accordion: "accordion", AlertDialog: "alert-dialog", AspectRatio: "aspect-ratio", Avatar: "avatar", Checkbox: "checkbox", Collapsible: "collapsible", ContextMenu: "context-menu", Dialog: "dialog", DropdownMenu: "dropdown-menu", HoverCard: "hover-card", Label: "label", Menubar: "menubar", NavigationMenu: "navigation-menu", Popover: "popover", Portal: "portal", Progress: "progress", RadioGroup: "radio-group", ScrollArea: "scroll-area", Select: "select", Separator: "separator", Slider: "slider", Slot: "slot", Switch: "switch", Tabs: "tabs", Toast: "toast", Toggle: "toggle", ToggleGroup: "toggle-group", Toolbar: "toolbar", Tooltip: "tooltip", VisuallyHidden: "visually-hidden",
};

const PASCAL = (name: string): string => name.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
const node = (name: string, props: Record<string, unknown> = {}, children: Array<ComposeNode | string> = []): ComposeNode => ({ export: name, props, children });

/**
 * What to draw from an item's exports: its main component (the item's name in PascalCase, else
 * its first component export) and, when it is a compound, the parts its kind needs to show.
 */
export function composeOf(itemName: string, exports: readonly string[], label: string): ComposeNode | null {
  const components = exports.filter((e) => /^[A-Z]/.test(e));
  // A block's page has only its default export (`export default function Page`).
  const main = components.find((e) => e === PASCAL(itemName)) ?? components[0] ?? (exports.includes("default") ? "default" : undefined);
  if (!main) return null;
  const has = (suffix: string): string | null => (components.includes(`${main}${suffix}`) ? `${main}${suffix}` : null);
  const [input, list, item, group, trigger, content, header, title, description, footer, menu] = ["Input", "List", "Item", "Group", "Trigger", "Content", "Header", "Title", "Description", "Footer", "Menu"].map(has);
  if (list && item) {
    // A command menu or listbox: a search field and a group of items.
    const items = ["Calendar", "Search emoji", "Calculator"].map((text) => node(item, {}, [text]));
    // Narrow enough that its five states fit side by side in the state strip.
    return node(main, { style: { minWidth: 220 } }, [...(input ? [node(input, { placeholder: "Type a command or search…" })] : []), node(list, {}, group ? [node(group, { heading: "Suggestions" }, items)] : items)]);
  }
  if (list && trigger && content) {
    return node(main, { defaultValue: "account" }, [
      node(list, {}, [node(trigger, { value: "account" }, ["Account"]), node(trigger, { value: "password" }, ["Password"])]),
      node(content, { value: "account" }, ["Make changes to your account here."]),
      node(content, { value: "password" }, ["Change your password here."]),
    ]);
  }
  if (menu && trigger) {
    // A menubar: each trigger inside a menu of its own.
    return node(main, {}, ["File", "Edit", "View"].map((text) => node(menu, {}, [node(trigger, {}, [text]), ...(content && item ? [node(content, {}, [node(item, {}, ["New tab"])])] : [])])));
  }
  if (item && trigger && content) {
    // An accordion: its triggers live inside items, the first one open.
    return node(main, { type: "single", collapsible: true, defaultValue: "item-1", style: { width: 320 } }, [
      node(item, { value: "item-1" }, [node(trigger, {}, ["Is it accessible?"]), node(content, {}, ["Yes, with your tokens."])]),
      node(item, { value: "item-2" }, [node(trigger, {}, ["Is it styled?"]), node(content, {}, ["In your theme."])]),
    ]);
  }
  if (trigger && content) {
    // A dialog, popover or sheet, drawn open: Try it closes it, and "Open again" brings it back.
    const head = header ? [node(header, {}, [...(title ? [node(title, {}, [label])] : []), ...(description ? [node(description, {}, ["A preview of this part in your theme."])] : [])])] : [...(title ? [node(title, {}, [label])] : [])];
    return node(main, { open: true }, [node(trigger, {}, [`Open ${label}`]), node(content, {}, head.length ? head : [label])]);
  }
  if (header || title || content) {
    return node(main, { style: { width: 320 } }, [
      ...(header ? [node(header, {}, [...(title ? [node(title, {}, [label])] : []), ...(description ? [node(description, {}, ["A preview of this part in your theme."])] : [])])] : title ? [node(title, {}, [label])] : []),
      ...(content ? [node(content, {}, ["Its content, drawn with your tokens."])] : []),
      ...(footer ? [node(footer, {}, [])] : []),
    ]);
  }
  if (/input|textarea/i.test(main)) return node(main, { placeholder: label });
  return node(main, {}, [label]);
}

/** The drawing is settled once nothing has changed for this long, or this long after it mounted at most. */
export const QUIET_MS = 400;
export const SETTLE_MAX_MS = 3000;

const BOOTSTRAP = `
const post = (message) => { try { parent.postMessage(Object.assign({ youi: "try" }, message), "*"); } catch (error) {} };
const icon = () => React.createElement("svg", { xmlns: "http://www.w3.org/2000/svg", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, React.createElement("path", { d: ${JSON.stringify(ICON_PATH)} }));
const container = document.getElementById("youi-specimen");
const exported = (name) => {
  const value = MODULE[name];
  if (value === undefined || value === null) throw new Error("the item has no export " + name);
  return value;
};
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
/** The markup it drew, portalled parts included, for the hub's static frames; settled once it has stopped changing. */
const snapshot = (settled) => {
  const parts = [container.innerHTML];
  for (const element of document.body.children) if (element !== container && element.tagName !== "SCRIPT") parts.push(element.outerHTML);
  post({ type: "html", html: parts.join(""), settled: Boolean(settled) });
};
/** When the page last changed: a chart animating in, a list filling, keep it changing. */
let changed = Date.now();
function Live() {
  const [open, setOpen] = React.useState(true);
  const build = (part, key) => {
    if (typeof part === "string") return part;
    const props = Object.assign({ key }, part.props);
    if (part === COMPOSE && part.props.open === true) Object.assign(props, { open, onOpenChange: (value) => setOpen(Boolean(value)) });
    return React.createElement(exported(part.export), props, ...part.children.map((child, i) => build(child, i)));
  };
  React.useEffect(() => {
    window.__youiReady = true;
    post({ type: "ready" });
    measure();
    // Timers, not animation frames: a frame the hub keeps out of sight gets no animation frames.
    // A first drawing at once, then the settled one: quiet for ${QUIET_MS} ms, or ${SETTLE_MAX_MS} ms on at most.
    setTimeout(() => snapshot(false), 60);
    const started = Date.now();
    const settle = () => (Date.now() - changed >= ${QUIET_MS} || Date.now() - started >= ${SETTLE_MAX_MS} ? snapshot(true) : setTimeout(settle, 100));
    setTimeout(settle, 100);
  }, []);
  React.useEffect(measure, [open]);
  return React.createElement(React.Fragment, null, build(COMPOSE, 0), COMPOSE.props.open === true && !open ? React.createElement("button", { type: "button", "data-youi-reopen": "", onClick: () => setOpen(true), style: { font: "inherit", padding: "6px 12px", border: "1px solid currentColor", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer" } }, "Open again") : null);
}
class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { post({ type: "error", message: String((error && error.message) || error).split("\\n")[0] }); }
  render() { return this.state.failed ? null : this.props.children; }
}
new MutationObserver(() => { changed = Date.now(); measure(); }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
if (typeof ResizeObserver !== "undefined") new ResizeObserver(measure).observe(document.body);
if (document.fonts) document.fonts.ready.then(measure, measure);
addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.defaultPrevented) post({ type: "escape" }); });
addEventListener("message", (event) => {
  if (event.source !== parent || !event.data || event.data.youi !== "try-focus") return;
  const first = document.body.querySelector('button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
  if (first) first.focus();
});
void icon;
createRoot(container).render(React.createElement(Boundary, null, React.createElement(Live)));
`;

const BANNER = `addEventListener("error", function (event) { if (!window.__youiReady) try { parent.postMessage({ youi: "try", type: "error", message: String(event.message || "the item's code failed to load").split("\\n")[0] }, "*"); } catch (error) {} });`;

const digestOf = (path: string): string | null => {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
};

/** The project's own `cn`, when one of its alias targets (`@/lib/utils`) exports it. */
function projectCn(root: string, tsconfig: string): string | null {
  for (const [prefix, target] of tsconfigAliases(root, tsconfig)) {
    if (prefix !== "@/" && prefix !== "~/") continue;
    for (const ext of [".ts", ".tsx", ".js"]) {
      const file = join(root, target, `lib/utils${ext}`);
      if (existsSync(file) && within(root, file) && /\bexport\s+(?:function|const|let)\s+cn\b|\bexport\s*\{[^}]*\bcn\b/.test(readFileSync(file, "utf8"))) return file;
    }
  }
  return null;
}

/**
 * Bundle a prepared preview for the browser, fenced to the project root, its packages and the
 * one preview directory. Resolves to the bundle and its notes, or a sentence saying why not.
 */
export async function bundlePreview(job: PreviewJob, options: { readonly bundleTimeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<PreviewResult> {
  const { root, dir, fallback = null, packages = null } = job;
  try {
    if (!packageUnderRoot(root, "react") || !packageUnderRoot(root, "react-dom")) return { error: "react and react-dom are not installed in your project's node_modules, so nothing can be drawn" };
    if (!existsSync(join(dir, job.main))) return { error: "the preview's files are missing; open it again" };
    const config = checkedTsconfig(root, job.tsconfig);
    const aliases = tsconfigAliases(root, job.tsconfig);
    const notes = new Set<string>();
    const refusals = new Set<string>();
    const fromHub = new Set<string>();
    const fetched = new Set<string>();
    const missing = new Set<string>();
    const radix = new Map<string, string>();
    const cnFile = projectCn(root, job.tsconfig);
    /** Where a fetched file's imports may land: the preview, the project's alias targets, and the project's or the hub's installed packages. */
    const partFiles = new Set((job.projectParts ?? []).filter((file) => within(root, file)).map(realOf));
    const codeRoots = [dir, ...aliases.map(([, target]) => join(root, target)), join(root, "node_modules"), ...[fallback, packages].flatMap((base) => (base ? [join(base, "node_modules")] : []))];
    const previewRoot = realOf(dir);
    const previewRefusal = (spec: string, path: string): string | null => {
      // A block's own data (dashboard-01's data.json) is part of what was fetched; JSON from anywhere else stays out.
      if (/\.json$/i.test(path) && within(previewRoot, realOf(path))) return null;
      if (!PREVIEW_CODE.test(path)) return `a preview may import code only (.ts, .tsx, .js, .jsx, .mjs, .cjs, .css, or its own .json), not ${basename(path)}`;
      const name = packageName(spec);
      if (name) for (const base of [root, fallback, packages]) {
        const pkg = base ? packageUnderRoot(base, name) : null;
        if (pkg && within(pkg, path)) return null;
      }
      if (codeRoots.some((base) => within(base, path))) return null;
      if (partFiles.has(realOf(path))) return null;
      return "it resolves outside the preview, your project's aliased source, the project components it was given and the installed packages";
    };
    const where = (spec: string): { base: string; from: "project" | "hub" | "fetched" } | null =>
      packageUnderRoot(root, spec) ? { base: root, from: "project" } : fallback && packageUnderRoot(fallback, spec) ? { base: fallback, from: "hub" } : packages && packageUnderRoot(packages, spec) ? { base: packages, from: "fetched" } : null;

    const fence: Plugin = {
      name: "youi-preview-fence",
      setup(build) {
        build.onResolve({ filter: /^(?:cn|radix-ui)$/ }, (args) => {
          if (args.namespace === NAMESPACE || where(args.path)) return undefined;
          if (args.path === "cn") return { path: "cn", namespace: NAMESPACE };
          // Only the parts this file asks for (`import { Dialog as DialogPrimitive } from "radix-ui"`).
          let text = "";
          try {
            text = isAbsolute(args.importer) && within(dir, args.importer) ? readFileSync(args.importer, "utf8") : "";
          } catch {
            text = "";
          }
          const names = [...text.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']radix-ui["']/g)].flatMap((m) => m[1]!.split(",").map((part) => part.trim().split(/\s+/)[0]!)).filter((name) => name in RADIX_PARTS);
          return { path: `radix-ui#${[...new Set(names)].sort().join(",")}`, namespace: NAMESPACE };
        });
        build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
          if (args.path === "cn") {
            if (cnFile) {
              notes.add(`cn: your ${cnFile.slice(realOf(root).length + 1)}`);
              return { contents: `export { cn } from ${JSON.stringify(cnFile)};`, loader: "js", resolveDir: root };
            }
            const merge = where("clsx") && where("tailwind-merge");
            notes.add(merge ? "cn: clsx and tailwind-merge, as shadcn's utils does (your project has no cn)" : "cn: a plain class join (your project has no cn)");
            return { contents: merge ? `import { clsx } from "clsx"; import { twMerge } from "tailwind-merge"; export function cn(...inputs) { return twMerge(clsx(inputs)); }` : `export function cn(...inputs) { return inputs.flat(Infinity).filter(Boolean).join(" "); }`, loader: "js", resolveDir: root };
          }
          const wanted = args.path.slice("radix-ui#".length).split(",").filter(Boolean);
          const parts = Object.entries(RADIX_PARTS).filter(([name, pkg]) => wanted.includes(name) && where(`@radix-ui/react-${pkg}`));
          const absent = wanted.filter((name) => !parts.some(([n]) => n === name));
          if (absent.length > 0) refusals.add(`it needs radix-ui's ${absent.join(", ")} (${absent.map((n) => `@radix-ui/react-${RADIX_PARTS[n]}`).join(", ")}), installed in neither your project nor the hub`);
          for (const [name, pkg] of parts) radix.set(name, `@radix-ui/react-${pkg}`);
          return { contents: parts.map(([name, pkg]) => `export * as ${name} from "@radix-ui/react-${pkg}";`).join("\n"), loader: "js", resolveDir: root };
        });
        build.onResolve({ filter: /.*/ }, async (args) => {
          if ((args.pluginData as Record<string, unknown> | undefined)?.[GUARDED] || args.kind === "entry-point") return undefined;
          const spec = args.path;
          const fromEntry = args.importer === "<stdin>" || args.importer === ENTRY || args.namespace === NAMESPACE;
          // Checked before anything else: a fetched file under a `node_modules/` folder of its own is still fetched code.
          const fromPreview = fromEntry || (isAbsolute(args.importer) && within(dir, args.importer));
          if (fromPreview && args.with && Object.keys(args.with).length > 0) {
            refusals.add(`refused import "${spec}": a preview may not import with attributes (${Object.entries(args.with).map(([k, v]) => `${k}: ${v}`).join(", ")}), only code`);
            return { errors: [{ text: `refused: ${spec}` }] };
          }
          // A package's own relative imports that stay inside it (lucide's thousand icons): esbuild resolves them as it would.
          if (!fromPreview && args.path.startsWith(".") && isAbsolute(args.importer) && args.importer.includes(`${sep}node_modules${sep}`)) {
            const at = args.importer.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules${sep}`.length;
            const rest = args.importer.slice(at).split(sep);
            const base = args.importer.slice(0, at) + rest.slice(0, rest[0]!.startsWith("@") ? 2 : 1).join(sep);
            const target = resolve(dirname(args.importer), args.path);
            if (target.startsWith(base + sep)) return undefined;
          }
          const again = (path: string, resolveDir: string) => build.resolve(path, { importer: args.importer, resolveDir, kind: args.kind, pluginData: { [GUARDED]: true }, with: args.with });
          let result;
          // One React: always the project's.
          if (/^react(?:-dom)?(?:\/.*)?$/.test(spec)) result = await again(spec, realOf(root));
          else if (fromPreview) {
            const name = packageName(spec);
            const alias = aliases.find(([prefix]) => spec.startsWith(prefix) && prefix.endsWith("/"));
            if (alias) {
              result = await again(join(realOf(root), alias[1], spec.slice(alias[0].length)), realOf(root));
              if (result.errors.length > 0) {
                refusals.add(`it needs ${spec}, which your project does not have`);
                return { errors: [{ text: `missing ${spec}` }] };
              }
            } else if (name && !spec.startsWith("@/")) {
              const found = where(spec);
              if (!found) {
                refusals.add(`it needs ${name}, which is installed in neither your project nor the hub`);
                missing.add(name);
                return { errors: [{ text: `missing ${name}` }] };
              }
              if (found.from === "hub") fromHub.add(name);
              if (found.from === "fetched") fetched.add(name);
              result = await again(spec, realOf(found.base));
            } else result = await again(spec, args.resolveDir || dir);
          } else result = await again(spec, args.resolveDir);
          if (result.errors.length > 0) return { errors: result.errors, warnings: result.warnings };
          if (fromPreview) {
            const reason = result.external || result.namespace !== "file" || !result.path ? "it is not a file in your project, its packages or the preview" : previewRefusal(spec, result.path);
            if (reason) {
              refusals.add(`refused import "${spec}": ${reason}`);
              return { errors: [{ text: `refused: ${spec}` }] };
            }
            return { path: result.path, namespace: "file", sideEffects: result.sideEffects, suffix: result.suffix };
          }
          if (result.external || result.namespace !== "file" || !result.path) return { path: result.path, external: result.external, namespace: result.namespace, sideEffects: result.sideEffects };
          const allowed = within(root, result.path) || inPackage(result.path);
          if (!allowed) {
            refusals.add(`refused import "${spec}": it resolves outside your project, its packages and the preview`);
            return { errors: [{ text: `refused: ${spec}` }] };
          }
          return { path: result.path, namespace: "file", sideEffects: result.sideEffects, suffix: result.suffix };
        });
      },
    };

    const entry = [
      `import * as React from "react";`,
      `import { createRoot } from "react-dom/client";`,
      `import * as MODULE from ${JSON.stringify(`./${job.main}`)};`,
      `const COMPOSE = ${JSON.stringify(job.compose)};`,
      BOOTSTRAP,
    ].join("\n");
    const timeoutMs = options.bundleTimeoutMs ?? BUNDLE_TIMEOUT_MS;
    let built: { text: string; inputs: string[] };
    try {
      built = await bundleWithin(
        {
          stdin: { contents: entry, resolveDir: realOf(dir), loader: "js", sourcefile: ENTRY },
          absWorkingDir: realOf(dir),
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
          plugins: [stubs(root, { portal: false }), fence],
        },
        timeoutMs,
        options.signal,
      );
    } catch (error: unknown) {
      if (options.signal?.aborted) return { error: "the preview was stopped before it bundled" };
      if (refusals.size > 0) return { error: [...refusals][0]!, ...(missing.size > 0 ? { missing: [...missing].sort() } : {}) };
      const message = bundleError(error);
      if (message.startsWith("esbuild timed out")) return { error: `bundling took over ${limitOf(timeoutMs)} and was stopped` };
      return { error: `it did not bundle: ${message}` };
    }
    // A radix-ui part nobody has bundles to nothing, and would only fail once it runs: say why now.
    if (refusals.size > 0) return { error: [...refusals][0]!, ...(missing.size > 0 ? { missing: [...missing].sort() } : {}) };
    if (radix.size > 0) notes.add(`radix-ui is not installed: its ${[...radix.keys()].sort().join(", ")} ${radix.size === 1 ? "comes" : "come"} from ${[...new Set(radix.values())].sort().join(", ")}`);
    if (fetched.size > 0) notes.add(`${[...fetched].sort().join(", ")}: not installed in your project, so ${fetched.size === 1 ? "a copy" : "copies"} fetched from npm for previews ${fetched.size === 1 ? "draws it" : "draw them"} (install ${fetched.size === 1 ? "it" : "them"} to use it for real)`);
    if (fromHub.size > 0) notes.add(`${[...fromHub].sort().join(", ")}: not installed in your project, so the hub's own ${fromHub.size === 1 ? "copy draws it" : "copies draw them"}`);
    const inputs: BundleInput[] = [];
    for (const input of built.inputs) {
      if (input === "<stdin>" || input === ENTRY || /^[\w-]+:/.test(input)) continue;
      const path = resolve(realOf(dir), input);
      inputs.push({ path, digest: digestOf(path) ?? "missing" });
    }
    return { hash: sha256(built.text).slice(0, 16), code: built.text, inputs, notes: [...notes] };
  } catch (error: unknown) {
    return { error: `it did not bundle: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
}
