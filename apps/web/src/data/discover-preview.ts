/**
 * An opened Discover candidate: the one request that may fetch anything. Asking the hub's server
 * (scripts/discover-preview-server.ts) fetches only that item's source into the cache, bundles
 * it in the user's project setting and builds the project's CSS over it; the answer names the
 * script and the two sheets by URL, and says what could and could not be themed. Asked once per
 * candidate and project (a second ask shares the first).
 *
 * The drawing itself happens in the browser: the bundle runs in a frame sandboxed with
 * `allow-scripts` only, and posts back the markup it drew (`html`), which the hub draws again in
 * script-free frames, light and dark and in each state. That markup comes from outside code, so
 * it is cleaned first: no scripts, frames, links, styles, event handlers or remote URLs survive.
 */
import { useSyncExternalStore } from "react";

export const PREVIEW_ENDPOINT = "__youi/discover-preview";

export interface ComposeNode {
  readonly export: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: ReadonlyArray<ComposeNode | string>;
}

export interface ThemeFit {
  readonly themed: readonly string[];
  readonly unthemed: readonly string[];
  readonly type: { readonly item: number | null; readonly project: number | null };
  readonly radius: number | null;
}

/** The server's answer (PreviewAnswer in scripts/discover-preview-server.ts). */
export interface PreviewAnswer {
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly script: string | null;
  readonly css: { readonly light: string; readonly dark: string } | null;
  readonly html: string;
  readonly compose: ComposeNode | null;
  readonly fit: ThemeFit;
  readonly notes: readonly string[];
  readonly parts: ReadonlyArray<{ readonly name: string; readonly from: string; readonly detail: string }>;
  readonly implicitDeps: readonly string[];
  readonly error: string | null;
  readonly install: { readonly command: string; readonly npm: readonly string[] } | null;
  readonly license: string;
  readonly fetched: boolean;
  readonly ms: number;
  /** The listing as youi.library/v1, for Save to Library and Add to my project. */
  readonly entry: import("@youiyoux/core").LibraryEntry;
}

export type PreviewState = { readonly status: "ready"; readonly answer: PreviewAnswer } | { readonly status: "error"; readonly message: string; readonly offline: boolean };

const asked = new Map<string, Promise<PreviewState>>();
/** Every preview asked for this page load, by id: what measure-discover counts. */
export const previewRequests: string[] = [];

/** Ask for one candidate's preview (once per candidate and project). */
export function requestPreview(id: string, project: string | null, base: string = import.meta.env.BASE_URL): Promise<PreviewState> {
  const key = `${base}\0${id}\0${project ?? ""}`;
  let request = asked.get(key);
  if (!request) {
    previewRequests.push(id);
    request = ask(id, project, base);
    asked.set(key, request);
    // A failure is not kept: opening it again asks again.
    void request.then((state) => state.status === "error" && asked.delete(key));
  }
  return request;
}

async function ask(id: string, project: string | null, base: string): Promise<PreviewState> {
  const params = new URLSearchParams({ id, ...(project ? { project } : {}) });
  let response: Response;
  try {
    response = await fetch(`${base}${PREVIEW_ENDPOINT}?${params}`, { cache: "no-store" });
  } catch {
    return { status: "error", message: "Previews need the hub's own server (youiyoux ui or pnpm dev), which did not answer; the listing stands.", offline: true };
  }
  const body = (await response.json().catch(() => null)) as (PreviewAnswer & { error: string | null }) | { error?: unknown } | null;
  if (response.ok && body && "id" in body) return { status: "ready", answer: body };
  if (body && typeof body.error === "string") return { status: "error", message: body.error, offline: false };
  return { status: "error", message: "Previews need the hub's own server (youiyoux ui or pnpm dev); this host only serves files, so the listing stands.", offline: true };
}

/* --------------------------------------------------------- the markup it drew */

const DROP = "script, iframe, frame, frameset, object, embed, link, meta, base, style, noscript, template, portal";
const URL_ATTRIBUTES = ["href", "src", "srcset", "action", "formaction", "xlink:href", "poster", "background", "ping"];

/** The drawn markup, safe to put in a script-free frame: no active content, no remote fetches. */
export function cleanMarkup(html: string): string {
  if (typeof document === "undefined") return "";
  const template = document.createElement("template");
  template.innerHTML = html.slice(0, 200_000);
  for (const element of template.content.querySelectorAll(DROP)) element.remove();
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      else if (URL_ATTRIBUTES.includes(name)) {
        const value = attribute.value.trim();
        if (!(name === "href" && value.startsWith("#")) && !/^data:image\/(?:png|gif|jpeg|webp);/i.test(value)) element.setAttribute(attribute.name, name === "href" ? "#" : "");
      } else if (name === "style" && /url\s*\(|expression\s*\(|@import/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  return template.innerHTML;
}

const drawn = new Map<string, string>();
const listeners = new Set<() => void>();

/** Keep what a candidate's frame drew (cleaned), for its static frames. */
export function setDrawn(id: string, html: string): void {
  const clean = cleanMarkup(html);
  if (!clean.trim() || drawn.get(id) === clean) return;
  drawn.set(id, clean);
  listeners.forEach((listener) => listener());
}

/** The markup a candidate's frame drew, once it has. */
export function useDrawn(id: string | null): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (id ? (drawn.get(id) ?? null) : null),
    () => null,
  );
}
