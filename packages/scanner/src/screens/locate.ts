/**
 * Where each React component on a page is drawn, and which line of the project rendered it.
 *
 * In a React development build each component's fiber keeps the stack of the JSX call that
 * created it (`_debugStack`). Its first frame whose source is the project's own (not React, not
 * node_modules) is the line that wrote `<Button …>`: the served module's source map turns each
 * frame into a file and line on disk, which is what the usage map's sites are keyed by. A bundle
 * that holds React and the app in one file is why the source, not the URL, decides.
 * A component's box is the union of the elements it draws (portals included), in page
 * coordinates. A production build keeps no stacks: its components are still boxed and named
 * (when names survive), but have no line, and `dev` says why.
 *
 * HTML that React did not create (server-rendered fragments a component places with
 * `dangerouslySetInnerHTML` or a ref) has no fibers. Its controls, headings, text and containers
 * are placed too, named by their tag and text (`html`), at the line of the component that placed
 * them: that line is where the fragment, and so a change to it, starts.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { posix } from "node:path";

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A stack frame as the browser saw it: the served module and the line and column in it (1-based). */
export interface Frame {
  readonly url: string;
  readonly line: number;
  readonly column: number;
}

/** One component on the page, before its frame is mapped back to the source. */
export interface RawPlace {
  readonly name: string;
  /** The component whose render created it. */
  readonly owner: string | null;
  /** The JSX call's frames, nearest first; the first that maps into the project is its line. */
  readonly frames: readonly Frame[];
  readonly box: Box;
  /** How many components it sits inside. */
  readonly depth: number;
  /** Plain HTML that React did not create: its tag (`button`); `name` then says which one. */
  readonly html?: string;
}

export interface PageLocation {
  /** React was found on the page. */
  readonly react: boolean;
  /** Its fibers carry the stacks a development build keeps. */
  readonly dev: boolean;
  /** The page's whole size, in CSS pixels. */
  readonly size: { readonly width: number; readonly height: number };
  readonly places: readonly RawPlace[];
  /** More components than the limit were on the page. */
  readonly capped: boolean;
}

/** One component placed on a screen: what it is, where it is, and the line that rendered it. */
export interface Place {
  readonly name: string;
  readonly owner: string | null;
  /** Project-relative, `/`-separated; null when its line could not be found. */
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly box: Box;
  readonly depth: number;
  /** Plain HTML that React did not create: its tag; the line is the component that placed it. */
  readonly html?: string;
  /** The line is inside a skipped file (a component of the System's own): no frame where the app rendered it mapped. */
  readonly own?: true;
  /**
   * With `promote`: the line past which this one was chosen, the first of the app's own lines on
   * the place's frames, inside a component the code uses in more than one place.
   */
  readonly renderedBy?: { readonly file: string; readonly line: number };
}

/** One of the project's lines a place's frames map to. */
export interface PlaceLine {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** In a skipped file (a component of the System's own): passed to `promote` in order, never shown. */
  readonly skipped?: true;
  /**
   * A frame between the first line and the next that couldn't be placed (no map, outside the root, a
   * library's, or a gap the page marked): passed to `promote` in order, never shown, never crossed.
   */
  readonly uncertain?: true;
}

/** How resolvePlaces picks a place's line among its frames. */
export interface ResolveChoice {
  /**
   * Files to pass over (the System's own components) for the next frame, where the app rendered it;
   * used only when nothing else maps, marked `own`.
   */
  readonly skip?: (file: string) => boolean;
  /**
   * Given the place's first line of the app's own and the project's lines after it (nearest first,
   * skipped ones included and marked), the line to show instead, or null to keep the first; the
   * first is then kept as `renderedBy`. Only an unskipped line from `rest` is taken.
   */
  readonly promote?: (first: PlaceLine, rest: readonly PlaceLine[]) => Promise<PlaceLine | null>;
}

/** Components recorded per page, at most. */
export const MAX_PLACES = 4000;

/**
 * Runs in the page (Playwright serialises it): every component fiber under every React root, its
 * box and its JSX call's frames (`maxFrames` of them: in a bundle React's own come first, then the
 * project's). Self-contained, so it may use nothing from this module.
 */
export function locateInPage(limit: number, maxFrames = 6): PageLocation {
  type Fiber = { tag: number; type: unknown; child: Fiber | null; sibling: Fiber | null; stateNode: unknown; _debugStack?: { stack?: string } | null; _debugOwner?: Fiber | null };
  const size = { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
  const roots: Fiber[] = [];
  for (const element of document.querySelectorAll("*")) {
    const key = Object.keys(element).find((k) => k.startsWith("__reactContainer$"));
    if (!key) continue;
    const container = (element as unknown as Record<string, Fiber & { stateNode?: { current?: Fiber } }>)[key]!;
    roots.push(container.stateNode?.current ?? container);
  }
  if (roots.length === 0) return { react: false, dev: false, size, places: [], capped: false };
  // Function, class, forwardRef, memo and simple memo components.
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const nameOf = (type: unknown): string | null => {
    const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } } | null;
    return t?.displayName || t?.name || t?.render?.displayName || t?.render?.name || t?.type?.displayName || t?.type?.name || null;
  };
  const INTERNAL = /\/node_modules\/|\/\.vite\/deps\/|\/_next\/static\/chunks\/(?:framework|main|webpack)|react-dom|jsx-dev-runtime|jsx-runtime/;
  const framesOf = (stack: string | undefined): Array<{ url: string; line: number; column: number }> => {
    const frames: Array<{ url: string; line: number; column: number }> = [];
    for (const text of (stack ?? "").split("\n").slice(1)) {
      if (/react[-_]stack[-_]bottom[-_]frame/.test(text)) break;
      const match = /((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/.exec(text);
      if (!match || INTERNAL.test(match[1]!)) continue;
      frames.push({ url: match[1]!, line: Number(match[2]), column: Number(match[3]) });
      if (frames.length >= maxFrames) break;
    }
    return frames;
  };
  const boxOf = (fiber: Fiber): { x: number; y: number; width: number; height: number } | null => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const walk = (first: Fiber | null): void => {
      for (let node = first; node; node = node.sibling) {
        if (node.tag === 5) {
          const rect = (node.stateNode as Element | null)?.getBoundingClientRect?.();
          if (rect && rect.width > 0 && rect.height > 0) {
            left = Math.min(left, rect.left);
            top = Math.min(top, rect.top);
            right = Math.max(right, rect.right);
            bottom = Math.max(bottom, rect.bottom);
          }
        } else if (node.tag !== 6) walk(node.child);
      }
    };
    walk(fiber.child);
    if (!Number.isFinite(left)) return null;
    return { x: Math.round(left + scrollX), y: Math.round(top + scrollY), width: Math.round(right - left), height: Math.round(bottom - top) };
  };
  const places: RawPlace[] = [];
  let dev = false;
  let capped = false;
  const add = (place: RawPlace): boolean => {
    if (places.length >= limit) capped = true;
    else places.push(place);
    return !capped;
  };
  // HTML React did not create: what a person would point at in it.
  const NOTABLE = /^(?:a|button|input|select|textarea|summary|details|label|h[1-6]|p|li|ul|ol|dl|dt|dd|img|svg|table|tr|th|td|form|fieldset|section|article|aside|nav|header|footer|figure|pre|code|blockquote)$/;
  const isReact = (element: Element): boolean => Object.keys(element).some((k) => k.startsWith("__reactFiber$"));
  const labelOf = (element: Element): string => {
    const tag = element.localName;
    const role = element.getAttribute("role");
    // A field is named by its label attributes, never by what is typed in it; a button by its text
    // before the form field it submits.
    const field = /^(?:input|select|textarea)$/.test(tag);
    const own = element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") || (field ? element.getAttribute("name") : null);
    const inside = field ? element.getAttribute("type") : /^(?:ul|ol|dl|table|form|fieldset|section|article|aside|nav|header|footer|figure|details|tr)$/.test(tag) ? element.querySelector("h1,h2,h3,h4,h5,h6,legend,caption,summary")?.textContent : element.textContent;
    const text = ((own || inside || "").trim() || element.getAttribute("name") || "").replace(/\s+/g, " ").trim();
    const what = role ? `${tag}[role=${role}]` : tag;
    return text ? `${what} "${text.length > 40 ? `${text.slice(0, 39)}…` : text}"` : what;
  };
  const foreign = (element: Element, holder: { name: string; frames: RawPlace["frames"] }, depth: number): boolean => {
    for (const child of element.children) {
      if (isReact(child)) continue;
      let inner = depth;
      const tag = child.localName;
      if (NOTABLE.test(tag) || child.hasAttribute("role")) {
        const rect = child.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          if (!add({ name: labelOf(child), owner: holder.name, frames: holder.frames, box: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) }, depth, html: tag })) return false;
          inner = depth + 1;
        }
      }
      // An svg's insides are its drawing, not things to point at.
      if (tag !== "svg" && !foreign(child, holder, inner)) return false;
    }
    return true;
  };
  const visit = (fiber: Fiber | null, depth: number, holder: { name: string; frames: RawPlace["frames"] } | null): void => {
    for (let node = fiber; node; node = node.sibling) {
      let inner = depth;
      let within = holder;
      if (COMPONENT.has(node.tag)) {
        if (node._debugStack) dev = true;
        const box = boxOf(node);
        const name = nameOf(node.type);
        const frames = framesOf(node._debugStack?.stack);
        if (name) within = { name, frames };
        if (box && name && !add({ name, owner: nameOf(node._debugOwner?.type), frames, box, depth })) return;
        inner = depth + 1;
      } else if (node.tag === 5 && within && node.stateNode instanceof Element && !foreign(node.stateNode, within, inner)) return;
      visit(node.child, inner, within);
      if (capped) return;
    }
  };
  for (const root of roots) visit(root.child, 0, null);
  return { react: true, dev, size, places, capped };
}

/* -------------------------------------------------------------------- source maps */

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

/** One mapping segment: generated column, then the source, line and column it came from (all 0-based). */
type Segment = readonly [generatedColumn: number, source: number, line: number, column: number];

export interface SourceMap {
  readonly sources: readonly string[];
  /** Segments per generated line, by generated column. */
  readonly lines: ReadonlyArray<readonly Segment[]>;
}

/** A version-3 source map's `mappings`, decoded (Base64 VLQ). */
export function decodeMap(map: { sources?: unknown; sourceRoot?: unknown; mappings?: unknown }): SourceMap | null {
  if (!Array.isArray(map.sources) || typeof map.mappings !== "string") return null;
  const root = typeof map.sourceRoot === "string" && map.sourceRoot ? map.sourceRoot.replace(/\/?$/, "/") : "";
  const sources = map.sources.map((s) => (typeof s === "string" ? `${root}${s}` : ""));
  const lines: Segment[][] = [];
  let source = 0;
  let line = 0;
  let column = 0;
  for (const text of map.mappings.split(";")) {
    const segments: Segment[] = [];
    let generated = 0;
    for (const part of text.split(",")) {
      if (!part) continue;
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of part) {
        const digit = DIGIT.get(char);
        if (digit === undefined) return null;
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      generated += values[0] ?? 0;
      if (values.length >= 4) {
        source += values[1]!;
        line += values[2]!;
        column += values[3]!;
        segments.push([generated, source, line, column]);
      }
    }
    lines.push(segments);
  }
  return { sources, lines };
}

/** Where generated line and column (1-based) came from: the source and its 1-based line and column. */
export function originalPosition(map: SourceMap, line: number, column: number): { source: string; line: number; column: number } | null {
  const segments = map.lines[line - 1];
  if (!segments?.length) return null;
  let found: Segment | null = null;
  for (const segment of segments) {
    if (segment[0] > column - 1) break;
    found = segment;
  }
  found ??= segments[0]!;
  const source = map.sources[found[1]];
  return source === undefined ? null : { source, line: found[2] + 1, column: found[3] + 1 };
}

/** A served module's source map, or why there is none: no comment naming one, or one that could not be read. */
async function findSourceMap(url: string, text: string, fetchText: (url: string) => Promise<string | null>): Promise<SourceMap | "none" | "unreadable"> {
  // The last such comment, however long: an inline map can be megabytes of base64 on one line.
  const at = text.lastIndexOf("sourceMappingURL=");
  if (at < 0 || !/\/\/[#@]\s*$/.test(text.slice(Math.max(0, at - 8), at))) return "none";
  const target = text.slice(at + "sourceMappingURL=".length).split(/\s/, 1)[0]!;
  if (!target) return "none";
  let json: string | null;
  if (target.startsWith("data:")) {
    const at = target.indexOf(",");
    const payload = target.slice(at + 1);
    json = /;base64/.test(target.slice(0, at)) ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
  } else json = await fetchText(new URL(target, url).href);
  if (!json) return "unreadable";
  try {
    return decodeMap(JSON.parse(json) as Record<string, unknown>) ?? "unreadable";
  } catch {
    return "unreadable";
  }
}

/** A served module's source map: inline, or at the URL its last comment names. */
export async function sourceMapOf(url: string, text: string, fetchText: (url: string) => Promise<string | null>): Promise<SourceMap | null> {
  const found = await findSourceMap(url, text, fetchText);
  return typeof found === "string" ? null : found;
}

/** What became of the scripts' source maps while placing components: what to say when none got a line. */
export interface MapNotes {
  /** Scripts with no source map comment. */
  readonly bare: Set<string>;
  /** Scripts whose source map could not be fetched or read. */
  readonly unreadable: Set<string>;
  /** Files the maps named outside the project's root (node_modules aside). */
  readonly outside: Set<string>;
}

export const mapNotes = (): MapNotes => ({ bare: new Set(), unreadable: new Set(), outside: new Set() });

/**
 * Why a development build's components got no lines, from what its maps did, with the fix; null
 * when its maps were read and named the project's files (the components are then a library's).
 */
export function whyNoLines(notes: MapNotes): string | null {
  const one = (set: Set<string>): string => [...set][0]!;
  if (notes.outside.size > 0) return `the source maps name files outside the product's root (such as ${one(notes.outside)}): pass --root <the product's root> so they can be matched`;
  if (notes.unreadable.size > 0) return `the scripts name source maps that could not be read (such as the one for ${one(notes.unreadable)}): serve each map beside its script`;
  if (notes.bare.size > 0) return `the app's scripts carry no source maps (such as ${one(notes.bare)}): build them with source maps in development (esbuild: sourcemap: "inline"; webpack: devtool: "eval-source-map"; Vite and next dev do it already) and capture again`;
  return null;
}

/**
 * A source a map names, as a project-relative path: resolved against the module's URL
 * (`NavRail.tsx` beside `/src/shell/NavRail.tsx`), Vite's `/@fs/<absolute>` and webpack's
 * `webpack://<app>/./src/x.tsx` included; an absolute path is made relative to `root`, or to its
 * real path (a bundler names sources by it: `/var/…` is `/private/var/…` on macOS).
 */
export function projectPath(source: string, moduleUrl: string, root: string | null): string | null {
  let path: string;
  const webpack = /^webpack:\/\/[^/]*\/(.*)$/.exec(source);
  if (webpack) path = `/${webpack[1]!.replace(/^\.\//, "")}`;
  else if (/^[a-z]+:\/\//i.test(source)) path = new URL(source).pathname;
  else if (source.startsWith("/")) path = source;
  else path = new URL(source, moduleUrl).pathname;
  path = decodeURIComponent(path).replace(/^\/@fs\//, "/");
  for (const base of root ? new Set([root, realOrSelf(root)]) : []) {
    const prefix = base.replace(/\\/g, "/").replace(/\/?$/, "/");
    if (path.startsWith(prefix)) return posix.normalize(path.slice(prefix.length));
  }
  if (/^\/(?:Users|home|private|var|tmp|opt|mnt|[A-Za-z]:)\//.test(path)) return null;
  const relative = posix.normalize(path.replace(/^\/+/, ""));
  return relative.startsWith("..") || relative === "." ? null : relative;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Decoded source maps kept between calls, by module and the exact text it was served with. */
export type SourceMapCache = Map<string, Promise<SourceMap | null>>;

/**
 * Each raw place with its frame mapped back to the project's file and line. Each served module is
 * fetched once per call, by `fetchText` (the dev server, which served it to the page). With
 * `cache`, a module served with the same text as before keeps its decoded map: an edited file is
 * served differently, so it is never answered from an old one.
 */
export async function resolvePlaces(raw: readonly RawPlace[], fetchText: (url: string) => Promise<string | null>, root: string | null = null, notes: MapNotes = mapNotes(), cache?: SourceMapCache, choice: ResolveChoice = {}): Promise<Place[]> {
  const { skip, promote } = choice;
  const maps = new Map<string, Promise<SourceMap | null>>();
  const mapFor = (url: string): Promise<SourceMap | null> => {
    const module = url.replace(/[?#].*$/, "");
    let found = maps.get(module);
    if (!found) {
      const script = module.split("/").at(-1) || module;
      const decode = async (text: string | null): Promise<SourceMap | null> => {
        const map = text === null ? "unreadable" : await findSourceMap(url, text, fetchText);
        if (map === "none") notes.bare.add(script);
        if (map === "unreadable") notes.unreadable.add(script);
        return typeof map === "string" ? null : map;
      };
      found = fetchText(url).then(
        (text) => {
          if (!cache || text === null) return decode(text);
          const key = `${module}#${createHash("sha1").update(text).digest("hex")}`;
          let kept = cache.get(key);
          if (!kept) cache.set(key, (kept = decode(text)));
          return kept;
        },
        () => null,
      );
      maps.set(module, found);
    }
    return found;
  };
  const lineKey = (l: PlaceLine): string => JSON.stringify([l.file, l.line, l.column]);
  return Promise.all(
    raw.map(async (place): Promise<Place> => {
      const base = { name: place.name, owner: place.owner, box: place.box, depth: place.depth, ...(place.html ? { html: place.html } : {}) };
      // The app's own lines on the frames, nearest first: only the first unless `promote` needs them all.
      // A frame in a skipped file (a component of the System's own) is passed over for the next, where
      // the app rendered it; only when nothing else maps is it used, marked `own`.
      const lines: PlaceLine[] = [];
      let own: PlaceLine | null = null;
      // With `promote`, a frame after the first line that can't be placed is kept as a boundary: promotion never crosses it.
      const boundary = () => {
        if (promote && lines.length > 0) lines.push({ file: "", line: 0, column: 0, uncertain: true });
      };
      for (const frame of place.frames) {
        // A gap the page marked (an owner with no frame of the app's own): never fetched.
        if (!(frame.line >= 1) || !frame.url) {
          boundary();
          continue;
        }
        const map = await mapFor(frame.url);
        const original = map ? originalPosition(map, frame.line, frame.column) : null;
        if (!original) {
          boundary();
          continue;
        }
        if (/(?:^|\/)node_modules\/|^webpack\/|^\(webpack\)/.test(original.source)) {
          boundary();
          continue;
        }
        const file = projectPath(original.source, frame.url, root);
        if (file && skip?.(file)) {
          if (lines.length === 0) own ??= { file, line: original.line, column: original.column };
          else if (promote) lines.push({ file, line: original.line, column: original.column, skipped: true });
          continue;
        }
        if (file) {
          const line = { file, line: original.line, column: original.column };
          if (!lines.some((l) => !l.uncertain && lineKey(l) === lineKey(line))) lines.push(line);
          if (!promote) break;
          continue;
        }
        if (lines.length === 0) notes.outside.add(original.source);
        else boundary();
      }
      if (lines.length > 0) {
        const first = lines[0]!;
        const rest = lines.slice(1);
        const up = promote ? await promote(first, rest).catch(() => null) : null;
        // Belt and braces: only one of the place's own lines is ever shown.
        const chosen = (up && !up.skipped && !up.uncertain && rest.find((l) => !l.skipped && !l.uncertain && lineKey(l) === lineKey(up))) || first;
        return { ...base, file: chosen.file, line: chosen.line, column: chosen.column, ...(chosen !== first ? { renderedBy: { file: first.file, line: first.line } } : {}) };
      }
      if (own) return { ...base, ...own, own: true };
      // No map: the served module's own path names the file, but not the line.
      const unmapped = place.frames[0];
      return { ...base, file: unmapped ? projectPath(unmapped.url.replace(/[?#].*$/, ""), unmapped.url, null) : null, line: null, column: null };
    }),
  );
}
