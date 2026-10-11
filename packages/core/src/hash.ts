import { createHash } from "node:crypto";

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A short, stable digest for display and fingerprints (first 12 hex chars of sha256). */
export function shortHash(content: string): string {
  return sha256(content).slice(0, 12);
}

/** Deterministic JSON: object keys sorted, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}
