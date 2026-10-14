/**
 * An npm registry on 127.0.0.1 for the pack test, so `npx <tarball>` installs youiyoux's runtime
 * dependencies with no network: each one (and theirs) is packed from the copy this workspace
 * already installed, at that exact version. Optional dependencies not installed here (other
 * platforms' ast-grep and esbuild binaries) are answered with a version for no platform, which npm
 * skips as it skips any optional dependency for another OS.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface Entry {
  readonly manifest: Manifest;
  readonly tarball: string | null;
}

export interface LocalRegistry {
  readonly url: string;
  /** Packages it served, by name. */
  readonly served: Set<string>;
  close(): Promise<void>;
}

/** The installed package directory of `name` as `from` would load it, or null. */
function installed(name: string, from: string): string | null {
  try {
    return dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
  } catch {
    // Packages whose exports hide package.json: walk node_modules up from `from`.
    for (let dir = from; dirname(dir) !== dir; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return candidate;
    }
    return null;
  }
}

/** Every package `root`'s dependencies need, packed once into a cache keyed by name and version. */
function collect(dependencies: Record<string, string>, from: string, cache: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const visit = (name: string, base: string, optional: boolean): void => {
    if (entries.has(name)) return;
    const dir = installed(name, base);
    if (!dir) {
      if (!optional) throw new Error(`${name} is not installed in this workspace: run pnpm install`);
      entries.set(name, { manifest: { name, version: "0.0.0-unavailable", os: ["none"] }, tarball: null });
      return;
    }
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
    const file = join(cache, `${name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`);
    if (!existsSync(file)) {
      const out = join(cache, `tmp-${process.pid}`);
      mkdirSync(out, { recursive: true });
      execFileSync("npm", ["pack", dir, "--ignore-scripts", "--pack-destination", out], { stdio: "ignore", env: { ...process.env, npm_config_update_notifier: "false" } });
      const [packed] = readdirSync(out);
      execFileSync("mv", [join(out, packed!), file]);
    }
    entries.set(name, { manifest, tarball: file });
    for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep, dir, false);
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) visit(dep, dir, true);
  };
  for (const name of Object.keys(dependencies)) visit(name, from, false);
  return entries;
}

export async function startRegistry(dependencies: Record<string, string>, from: string, packed?: { manifest: Manifest; tarball: string }): Promise<LocalRegistry> {
  const cache = join(tmpdir(), "youiyoux-pack-registry");
  mkdirSync(cache, { recursive: true });
  const entries = collect(dependencies, from, cache);
  if (packed) entries.set(packed.manifest.name, packed);
  const served = new Set<string>();
  let base = "";
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]!.slice(1));
    if (path.startsWith("-/tarballs/")) {
      const entry = [...entries.values()].find((e) => e.tarball && e.tarball.endsWith(`/${path.slice("-/tarballs/".length)}`));
      if (!entry?.tarball) return void response.writeHead(404).end();
      served.add(entry.manifest.name);
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(entry.tarball));
      return;
    }
    const entry = entries.get(path);
    if (!entry) return void response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    const { manifest, tarball } = entry;
    const dist = tarball
      ? { tarball: `${base}/-/tarballs/${tarball.slice(tarball.lastIndexOf("/") + 1)}`, integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}` }
      : { tarball: `${base}/-/tarballs/unavailable.tgz` };
    const version = { ...manifest, _id: `${manifest.name}@${manifest.version}`, dist };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: version } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { url: base, served, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
