/**
 * Live screens, the service's side (the hub's Screens canvas frames the product's running app,
 * which loads scanner's bridge.ts): where the app runs, from the product's
 * `.youi/screens/screens.json` (`base`, recorded by `youiyoux screens capture`), and the frames of
 * the components under the pointer mapped to the product's files and lines with the app's source
 * maps, as capture maps them. Scripts and maps are fetched from the app's own origin only, without
 * following a redirect, so a frame naming another address is answered with no line.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readScreensSpec, resolvePlaces, type Place, type RawPlace, type SourceMapCache } from "@youiyoux/scanner";
import type { LiveInfo } from "./api.ts";
import { WorkflowError } from "./policy.ts";

const FETCH_TIMEOUT_MS = 10_000;
/** A script or map larger than this is not read (an inline map of a whole app is a few MB). */
const MAX_TEXT = 64 * 1024 * 1024;
/** Decoded maps kept; past this the cache starts again. */
const MAX_KEPT = 64;

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

  /** The places' frames mapped to the product's files and lines. */
  async resolve(places: readonly RawPlace[]): Promise<Place[]> {
    const { base, why } = this.info();
    if (!base) throw new WorkflowError("conflict", why ?? "the app's address is not known");
    const origin = new URL(base).origin;
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
    return resolvePlaces(places, fetchText, this.root, undefined, this.maps);
  }
}
