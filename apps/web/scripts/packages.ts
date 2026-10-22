/**
 * The tool's own packages, for the hub's scripts and server endpoints: loaded on first use from
 * their sources in this checkout, and typed by each caller, so the hub's typecheck never pulls in
 * the scanner's sources. The npm package's build (packages/youiyoux/build.mjs) puts its bundled
 * packages in this file's place, as it does for the CLI's tool.ts.
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ToolPackage = "core" | "scanner" | "discover" | "tokens";

const PACKAGES = resolve(import.meta.dirname, "../../../packages");

export const loadPackage = async <T>(name: ToolPackage): Promise<T> => (await import(pathToFileURL(join(PACKAGES, name, "src/index.ts")).href)) as T;
