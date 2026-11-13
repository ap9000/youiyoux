/**
 * Live screens, the service's side (the hub's Screens canvas frames the product's running app,
 * which loads scanner's bridge.ts): where the app runs, from the product's
 * `.youi/screens/screens.json` (`base`, recorded by `youiyoux screens capture`), and the frames of
 * the components under the pointer mapped to the product's files and lines with the app's source
 * maps, as capture maps them. Scripts and maps are fetched from the app's own origin only, without
 * following a redirect, so a frame naming another address is answered with no line.
 *
 * A live edit is written into the product's code here (`edit`): the element at the place's file and
 * line changed as scanner's editJsx changes it, shown first and written only when the file is still
 * the one shown (its hash), inside the product, a script, and a file of its own (never a link).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { writeFileAtomic } from "@youiyoux/core";
import { editJsx, readScreensSpec, resolvePlaces, type JsxEdit, type Place, type RawPlace, type ResolveChoice, type SourceMapCache } from "@youiyoux/scanner";
import type { LiveCodeEdit, LiveInfo } from "./api.ts";
import { WorkflowError } from "./policy.ts";

const FETCH_TIMEOUT_MS = 10_000;
/** A script or map larger than this is not read (an inline map of a whole app is a few MB). */
const MAX_TEXT = 64 * 1024 * 1024;
/** Decoded maps kept; past this the cache starts again. */
const MAX_KEPT = 64;
/** A source file a live edit opens: a component file, not a bundle. */
const MAX_SOURCE = 2 * 1024 * 1024;
const SCRIPT = /\.(?:tsx|jsx|ts|js|mjs)$/;

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export class LiveApp {
  readonly root: string;
  /** The product's id (youi.project.json), as its screens and requests name it. */
  readonly project: string;
  private readonly maps: SourceMapCache = new Map();

  constructor(root: string, project: string) {
    this.root = root;
    this.project = project;
  }

  info(): LiveInfo {
    const dir = join(this.root, ".youi/screens");
    if (!existsSync(join(dir, "screens.json"))) return { project: this.project, base: null, viewport: null, screens: [], why: "no screens are captured yet: youiyoux screens capture --base <url> takes them and records where the app runs" };
    let spec: ReturnType<typeof readScreensSpec>;
    try {
      spec = readScreensSpec(dir);
    } catch (error: unknown) {
      throw new WorkflowError("invalid", error instanceof Error ? error.message : String(error));
    }
    const screens = spec.screens.map(({ route, path }) => ({ route, path }));
    const base = spec.base && /^https?:\/\/[^/]/.test(spec.base) ? spec.base.replace(/\/+$/, "") : null;
    if (!base) return { project: this.project, base: null, viewport: spec.viewport, screens, why: "screens.json does not say where the app runs: capture again with youiyoux screens capture --base <url>" };
    return { project: this.project, base, viewport: spec.viewport, screens };
  }

  /**
   * The places' frames mapped to the product's files and lines. `origin` pins where scripts and maps
   * may be fetched from (a behaviour probe passes the origin it was consented for, so a base that
   * moves mid-run is never followed); without it, the origin of screens.json's base now. `skip` and
   * `distinct` choose among a place's frames (resolvePlaces' ResolveChoice).
   */
  async resolve(places: readonly RawPlace[], options: { readonly origin?: string } & ResolveChoice = {}): Promise<Place[]> {
    let origin: string;
    if (options.origin) origin = new URL(options.origin).origin;
    else {
      const { base, why } = this.info();
      if (!base) throw new WorkflowError("conflict", why ?? "the app's address is not known");
      origin = new URL(base).origin;
    }
    const fetchText = async (url: string): Promise<string | null> => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return null;
      }
      if (target.origin !== origin) return null;
      const response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
      if (!response?.ok || Number(response.headers.get("content-length") ?? 0) > MAX_TEXT) return null;
      const text = await response.text().catch(() => null);
      return text !== null && text.length <= MAX_TEXT ? text : null;
    };
    if (this.maps.size > MAX_KEPT) this.maps.clear();
    return resolvePlaces(places, fetchText, this.root, undefined, this.maps, { ...(options.skip ? { skip: options.skip } : {}), ...(options.distinct ? { distinct: true } : {}) });
  }

  /**
   * A live edit in the code: what it changes (always), and with `write` and the hash it was shown
   * with, the file written. The file is the place's, relative to the product; anything outside it, a
   * link, or not a script is refused, and so is a file changed since it was shown.
   */
  async edit(file: string, edit: JsxEdit, write: { readonly hash: string } | null): Promise<LiveCodeEdit> {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..") || !SCRIPT.test(file)) throw new WorkflowError("bad-request", `${file} isn't a script in the product`);
    const root = await realpath(this.root);
    const path = join(root, file);
    const stat = await lstat(path).catch(() => null);
    if (!stat) throw new WorkflowError("not-found", `${file} isn't in the product any more: capture the screen again`);
    if (!stat.isFile()) throw new WorkflowError("bad-request", `${file} is a link or not a file: live edits change a file of the product's own`);
    if (stat.size > MAX_SOURCE) throw new WorkflowError("bad-request", `${file} is larger than a component file (over 2 MB)`);
    const real = await realpath(path);
    if (relative(root, real).startsWith(`..${sep}`) || isAbsolute(relative(root, real))) throw new WorkflowError("bad-request", `${file} is outside the product`);
    const source = await readFile(real, "utf8");
    const hash = hashOf(source);
    if (write && write.hash !== hash) throw new WorkflowError("stale", `${file} changed since this edit was shown: look at it again before writing it`);
    const result = editJsx(source, file, edit);
    if (!result.ok) return { file, hash, ok: false, why: result.why };
    if (write) await writeFileAtomic(real, result.source);
    return { file, hash, ok: true, tag: result.tag, line: result.line, before: result.before, after: result.after, written: write !== null };
  }
}
