/**
 * What the hub and the preview frame say to each other over postMessage (same origin only).
 * The hub posts the scheme, the style editor's variable overrides, a pinned state and the
 * system's token list; the frame posts its height and that it is ready.
 */
import type { PinnedState } from "./pin.ts";

type PreviewScheme = "light" | "dark";

/** Representative screens the style editor previews, beside one component's demo; `token` is the phone's edited-token view. */
export type PreviewScreen = "components" | "type" | "scale" | "motion" | "focus" | "token";

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

/**
 * Where a token shows: text, a surface, a border, a ring, a shape's corners, a gap. `on` is the
 * surface under a text sample, `fg` the text on a surface sample (CSS variables, from the same
 * component), and `demo` the component's demo when the use is a component's role.
 */
export interface PreviewTokenUse {
  readonly kind: "text" | "surface" | "border" | "ring" | "shadow" | "radius" | "space" | "type";
  readonly label: string;
  /** The type of the token behind `cssVar`. */
  readonly type: string;
  /** The variable that carries the token here: its own, or a composite's (`--x-border-control`) that reads it. */
  readonly cssVar: string;
  readonly on?: string;
  readonly fg?: string;
  readonly demo?: string;
}

/** The token the phone preview shows: its own variable and its direct uses. */
export interface PreviewFocus {
  readonly path: string;
  readonly type: string;
  readonly cssVar: string;
  readonly uses: readonly PreviewTokenUse[];
  /** The uses come from the token's name, as nothing in the system reads it directly. */
  readonly byName: boolean;
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
  | { readonly type: "yx-preview-focus"; readonly focus: PreviewFocus | null }
  | { readonly type: "yx-preview-replay" };

export type FromFrame = { readonly type: "yx-preview-size"; readonly height: number } | { readonly type: "yx-preview-ready" };
