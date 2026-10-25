/**
 * Discover's pictures on the hub: each candidate as `youiyoux discover previews` photographed it
 * in the project's theme, light and dark, from the hub's own server (`/__youi/discover-thumbs`,
 * scripts/discover-thumbs.ts). A static host has no such endpoint, and any answer that is not the
 * pictures' JSON counts as none: Discover then lists without them. Asked once per page load.
 */
import { useEffect, useState } from "react";

const THUMBS_ENDPOINT = "__youi/discover-thumbs";

interface Thumb {
  readonly light: string;
  readonly dark: string;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
}

export interface Thumbs {
  readonly project: string;
  readonly items: Readonly<Record<string, Thumb>>;
  /** Candidates that could not be drawn on their own, with why. */
  readonly failed: Readonly<Record<string, string>>;
}

const isThumbs = (value: unknown): value is Thumbs => {
  const v = value as Partial<Thumbs> | null;
  return !!v && typeof v.project === "string" && typeof v.items === "object" && v.items !== null && typeof v.failed === "object" && v.failed !== null;
};

let asked: Promise<Thumbs | null> | null = null;

/** The pictures there are, or null when this hub has none to give. */
function loadThumbs(): Promise<Thumbs | null> {
  asked ??= fetch(`${import.meta.env.BASE_URL}${THUMBS_ENDPOINT}`, { headers: { Accept: "application/json" } }).then(
    async (res) => {
      if (!res.ok || !res.headers.get("Content-Type")?.includes("application/json")) return null;
      const body: unknown = await res.json().catch(() => null);
      return isThumbs(body) ? body : null;
    },
    () => null,
  );
  return asked;
}

/** Forget the answer (a test's next page load). */
export function resetThumbs(): void {
  asked = null;
}

/** The pictures, once asked: undefined while asking, null when there are none to give. */
export function useThumbs(): Thumbs | null | undefined {
  const [thumbs, setThumbs] = useState<Thumbs | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadThumbs().then((answer) => !cancelled && setThumbs(answer));
    return () => {
      cancelled = true;
    };
  }, []);
  return thumbs;
}

/** Whether the gallery has anything to show. */
export const hasPictures = (thumbs: Thumbs | null | undefined): thumbs is Thumbs => !!thumbs && Object.keys(thumbs.items).length > 0;

/**
 * Why a candidate has no picture, in the few words a card has room for; the whole sentence is its
 * title. `it needs recharts, which…` → `Needs recharts`.
 */
export function shortReason(reason: string): string {
  const part = /^it needs @\/registry\/[^/]+\/(?:ui|blocks|components)\/([\w.-]+)/i.exec(reason);
  if (part) return `Needs its ${part[1]} part`;
  const needs = /^it needs (?:radix-ui's )?([@\w./-]+?)(?:,| \(|$)/i.exec(reason);
  if (needs) return `Needs ${needs[1]}`;
  if (/failed when it ran/i.test(reason)) return "Fails when drawn alone";
  if (/draws nothing visible/i.test(reason)) return "Draws nothing on its own";
  if (/did not draw within|took over/i.test(reason)) return "Timed out drawing";
  if (/exports no component/i.test(reason)) return "Nothing to draw";
  if (/paid or private/i.test(reason)) return "Paid or private";
  return "Not drawn on its own";
}
