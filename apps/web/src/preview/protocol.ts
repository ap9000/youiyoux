/**
 * What the hub and the preview frame say to each other over postMessage (same origin only).
 * The hub posts the scheme, the style editor's variable overrides, a pinned state and the
 * system's token list; the frame posts its height and that it is ready.
 */
import type { PinnedState } from "./pin.ts";

export type PreviewScheme = "light" | "dark";

/** Representative screens the style editor previews, beside one component's demo. */
export type PreviewScreen = "components" | "type" | "scale" | "motion" | "focus";

export const PREVIEW_SCREENS: ReadonlyArray<{ readonly value: PreviewScreen; readonly label: string }> = [
  { value: "components", label: "Components" },
  { value: "type", label: "Type & colour" },
  { value: "scale", label: "Space & shape" },
  { value: "motion", label: "Motion" },
  { value: "focus", label: "Focus" },
];

/** A token as the frame's specimens use it: they read only its CSS variable, so overrides show at once. */
export interface PreviewToken {
  readonly path: string;
  readonly type: string;
  readonly cssVar: string;
}

/** CSS variable → value, per scheme: set on the system's root, over the generated sheet. */
export interface PreviewVars {
  readonly light: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
}

export type ToFrame =
  | { readonly type: "yx-preview-scheme"; readonly scheme: PreviewScheme }
  | { readonly type: "yx-preview-vars"; readonly vars: PreviewVars }
  | { readonly type: "yx-preview-state"; readonly state: PinnedState | null }
  | { readonly type: "yx-preview-tokens"; readonly tokens: readonly PreviewToken[] }
  | { readonly type: "yx-preview-replay" };

export type FromFrame = { readonly type: "yx-preview-size"; readonly height: number } | { readonly type: "yx-preview-ready" };
