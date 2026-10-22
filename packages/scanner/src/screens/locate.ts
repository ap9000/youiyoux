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
 */
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
  const visit = (fiber: Fiber | null, depth: number): void => {
    for (let node = fiber; node; node = node.sibling) {
      let inner = depth;
      if (COMPONENT.has(node.tag)) {
        if (node._debugStack) dev = true;
        const box = boxOf(node);
        const name = nameOf(node.type);
        if (box && name) {
          if (places.length >= limit) {
            capped = true;
            return;
          }
          places.push({ name, owner: nameOf(node._debugOwner?.type), frames: framesOf(node._debugStack?.stack), box, depth });
        }
        inner = depth + 1;
      }
      visit(node.child, inner);
      if (capped) return;
    }
  };
  for (const root of roots) visit(root.child, 0);
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

/** A served module's source map: inline, or at the URL its last comment names. */
export async function sourceMapOf(url: string, text: string, fetchText: (url: string) => Promise<string | null>): Promise<SourceMap | null> {
  const comment = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(text.slice(-200_000));
  if (!comment) return null;
  const target = comment[1]!;
  let json: string | null;
  if (target.startsWith("data:")) {
    const at = target.indexOf(",");
    const payload = target.slice(at + 1);
    json = /;base64/.test(target.slice(0, at)) ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
  } else json = await fetchText(new URL(target, url).href);
  if (!json) return null;
  try {
    return decodeMap(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return null;
  }
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
  else if (/^[a-z]+:\/\//i.test(source) && !source.startsWith("file://")) path = new URL(source).pathname;
  else if (source.startsWith("file://")) path = new URL(source).pathname;
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

/**
 * Each raw place with its frame mapped back to the project's file and line. Each served module is
 * fetched once, by `fetchText` (the dev server, which served it to the page).
 */
export async function resolvePlaces(raw: readonly RawPlace[], fetchText: (url: string) => Promise<string | null>, root: string | null = null): Promise<Place[]> {
  const maps = new Map<string, Promise<SourceMap | null>>();
  const mapFor = (url: string): Promise<SourceMap | null> => {
    const module = url.replace(/[?#].*$/, "");
    let found = maps.get(module);
    if (!found) {
      found = fetchText(url).then((text) => (text === null ? null : sourceMapOf(url, text, fetchText)), () => null);
      maps.set(module, found);
    }
    return found;
  };
  return Promise.all(
    raw.map(async (place): Promise<Place> => {
      const base = { name: place.name, owner: place.owner, box: place.box, depth: place.depth };
      for (const frame of place.frames) {
        const map = await mapFor(frame.url);
        const original = map ? originalPosition(map, frame.line, frame.column) : null;
        if (!original) continue;
        if (/(?:^|\/)node_modules\/|^webpack\/|^\(webpack\)/.test(original.source)) continue;
        const file = projectPath(original.source, frame.url, root);
        if (file) return { ...base, file, line: original.line, column: original.column };
      }
      // No map: the served module's own path names the file, but not the line.
      const unmapped = place.frames[0];
      return { ...base, file: unmapped ? projectPath(unmapped.url.replace(/[?#].*$/, ""), unmapped.url, null) : null, line: null, column: null };
    }),
  );
}
