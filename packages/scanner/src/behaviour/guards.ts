/**
 * What a behaviour probe may open, and the words for what it refused (docs/plans/behaviour-rules.md,
 * "Probe safety"). Pure: consent from `screens.json`, the one origin every request must be on, the
 * methods that may leave, and how a refused request is described (its path, never its query string).
 */
import { BehaviourConsent, LOOPBACK_HOSTNAMES } from "@youiyoux/core";

/** What the hub says before probing is switched on, and `behave` says when it isn't. */
export const CONSENT_WORDS = "Probes click buttons that open menus and dialogs in your running app. Use a dev app with test data.";
export const SIGN_IN_WORDS = "this screen needs a signed-in session; probing signed-in screens isn't supported yet";
export const SIGN_IN_FIX = "Next: probe screens that work signed out; signed-in screens need their own design (test accounts) and aren't probed yet.";

/** The only methods a probed page may send; anything else is stopped before it leaves. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export type Consent = { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly why: string; readonly fix: string };

const switchOn = (origin: string | null): string =>
  `Next: switch probing on in the hub's Behaviour tab, or add "behaviour": { "allowedOrigin": "${origin ?? "<the origin of base>"}" } to .youi/screens/screens.json.`;

/** The exact origin of `base` when it is an http address on this machine; else why not. */
export function probeOrigin(base: unknown): Consent {
  if (typeof base !== "string" || !base) return { ok: false, why: "screens.json does not say where the app runs", fix: "Next: capture again with youiyoux screens capture --base <url of the app in development>." };
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { ok: false, why: `screens.json's base (${base}) isn't an address`, fix: "Next: capture again with youiyoux screens capture --base <url of the app in development>." };
  }
  // http only: the probe's network fence sees inside plain http, so it can stop writes and every
  // WebSocket; inside an https tunnel it couldn't.
  if (url.protocol !== "http:") return { ok: false, why: `probes open an http dev server on this machine; ${url.origin} is ${url.protocol.replace(":", "")}`, fix: "Next: run the app's dev server on http://localhost and capture again with youiyoux screens capture --base <that url>." };
  if (url.username || url.password) return { ok: false, why: "screens.json's base carries a user name or password; probes never send credentials", fix: "Next: capture again with a base without credentials." };
  if (!LOOPBACK_HOSTNAMES.includes(url.hostname)) return { ok: false, why: `probes open an app on this machine only (localhost, 127.0.0.1 or ::1); ${url.origin} isn't`, fix: "Next: run the app's dev server on this machine, with test data, and capture again with youiyoux screens capture --base <that url>." };
  return { ok: true, origin: url.origin };
}

/**
 * Whether `screens.json` consents to probing now: its `behaviour.allowedOrigin` must be exactly the
 * origin of its current `base`, and that origin on this machine. The field being there is never
 * enough: a capture that moves `base` elsewhere leaves no consent.
 */
export function behaviourConsent(spec: { readonly base?: unknown; readonly behaviour?: unknown }): Consent {
  if (spec.behaviour === undefined) {
    const at = probeOrigin(spec.base);
    return { ok: false, why: `${CONSENT_WORDS} Probing isn't switched on for this app.`, fix: switchOn(at.ok ? at.origin : null) };
  }
  const consent = BehaviourConsent.safeParse(spec.behaviour);
  if (!consent.success) return { ok: false, why: `${CONSENT_WORDS} screens.json's behaviour block isn't { "allowedOrigin": "<origin>" }, so probing isn't switched on.`, fix: switchOn(null) };
  const at = probeOrigin(spec.base);
  if (!at.ok) return at;
  if (consent.data.allowedOrigin !== at.origin)
    return { ok: false, why: `${CONSENT_WORDS} Probing was switched on for ${consent.data.allowedOrigin}, but the app now runs at ${at.origin}.`, fix: switchOn(at.origin) };
  return at;
}

/**
 * `spec` with a new `base`. Consent to probe is bound to an origin, so it is kept only when the new
 * base is on the origin it names; on any other it is dropped, and probing must be switched on again.
 */
export function withBase<T extends { readonly base?: unknown; readonly behaviour?: unknown }>(spec: T, base: string): T & { base: string } {
  const { behaviour, ...rest } = spec;
  if (behaviour === undefined) return { ...spec, base };
  const consent = BehaviourConsent.safeParse(behaviour);
  let origin: string | null = null;
  try {
    origin = new URL(base).origin;
  } catch {
    // An unreadable base keeps no consent.
  }
  return (consent.success && consent.data.allowedOrigin === origin ? { ...spec, base } : { ...rest, base }) as T & { base: string };
}

/** A screen's address on the consented origin; a path that leads anywhere else is refused. */
export function screenUrl(origin: string, path: string): string {
  if (!/^\/(?![/\\])/.test(path) || path.includes("\\")) throw new Error(`the screen's path (${path}) must start with a single / on ${origin}; probes open nothing elsewhere`);
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin) throw new Error(`the screen's path (${path}) leads off ${origin}; probes open nothing elsewhere`);
  return url.href;
}

/** A URL as a refusal names it: its path, without query string or fragment; another origin's, with that origin. */
export function describeUrl(url: string, origin: string): string {
  try {
    const parsed = new URL(String(url));
    return parsed.origin === origin ? parsed.pathname : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "an address that couldn't be read";
  }
}

export type RequestVerdict = { readonly allow: true } | { readonly allow: false; readonly kind: "write" | "origin"; readonly words: string };

/** Whether a request may leave: on the exact origin, with a method that only reads. Never throws: what it can't read is refused. */
export function requestVerdict(url: string, method: string, origin: string): RequestVerdict {
  let parsed: URL | null = null;
  try {
    parsed = new URL(String(url));
  } catch {
    // Refused below.
  }
  if (!parsed || parsed.origin !== origin) return { allow: false, kind: "origin", words: `the page tried to reach ${describeUrl(url, origin)}, which isn't ${origin}; nothing was sent` };
  const upper = String(method).toUpperCase();
  if (!SAFE_METHODS.has(upper)) return { allow: false, kind: "write", words: `the page tried to send a ${upper} to ${describeUrl(url, origin)}; nothing was sent` };
  return { allow: true };
}

/** A path that looks like a sign-in page: where an app sends a visitor who isn't signed in. */
export const SIGN_IN_PATH = /(?:^|\/)(?:sign[-_]?in|log[-_]?in|auth|sso|session|account\/login)(?:\/|$|\.)/i;
