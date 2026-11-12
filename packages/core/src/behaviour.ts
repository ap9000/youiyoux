/**
 * Behaviour rules: how a popup behaves when someone uses it (Esc closes it, focus goes back to
 * the button that opened it, arrow keys move through a menu), checked by a probe run in the
 * running app, never by the code scan. Each check is defined per WAI-ARIA Authoring Practices
 * pattern; see `BEHAVIOUR_CHECKS` (rules.ts) and docs/plans/behaviour-rules.md.
 *
 * `BehaviourResult` is the canonical record of one check on one target: it is never turned into
 * a `Violation` (which needs file, line and column the probe may not know).
 */
import { z } from "zod";
import { ElementId } from "./ids.ts";

/** The popup patterns v1 checks, after the APG patterns of the same names. */
export const BEHAVIOUR_PATTERNS = ["menu-button", "combobox-listbox", "modal-dialog", "popover"] as const;
export const BehaviourPattern = z.enum(BEHAVIOUR_PATTERNS);
export type BehaviourPattern = z.infer<typeof BehaviourPattern>;

/** The closed list of behaviour checks a rule may declare. */
export const BEHAVIOUR_CHECK_IDS = ["trigger-state", "dismiss-escape", "focus-into", "focus-return", "focus-trap", "arrow-keys"] as const;
export const BehaviourCheckId = z.enum(BEHAVIOUR_CHECK_IDS);
export type BehaviourCheckId = z.infer<typeof BehaviourCheckId>;

/** A behaviour check's options. None are read yet, so any key is refused rather than silently ignored. */
export const BehaviourOptions = z.object({}).strict();

/**
 * A part of a component, inside its root: by its `data-part` / `data-slot` value, or by its ARIA role.
 * Names only, never a selector, so a contract cannot point a probe at arbitrary markup.
 */
export const PartRef = z.union([
  z.object({ part: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "expected a data-part or data-slot value (letters, digits, - and _)") }).strict(),
  z.object({ role: z.string().regex(/^[a-z]{1,32}$/, "expected an ARIA role such as menu or dialog") }).strict(),
]);
export type PartRef = z.infer<typeof PartRef>;

/**
 * A component contract's behaviour binding (`a11y.behaviour`): which pattern it implements, and
 * where its trigger, popup and focus-return parts are. A probe uses it before the DOM's own claims.
 */
/**
 * A trigger part: by its `data-part` / `data-slot` value, or by role, and then only `button` or
 * `combobox`. A probe clicks the trigger, so a binding can never point it at a menu item, an
 * option, a tab or a link (the probe checks the element itself again before any click).
 */
export const TriggerPartRef = z.union([
  z.object({ part: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "expected a data-part or data-slot value (letters, digits, - and _)") }).strict(),
  z.object({ role: z.enum(["button", "combobox"]) }).strict(),
]);

export const BehaviourBinding = z
  .object({
    pattern: BehaviourPattern,
    trigger: TriggerPartRef.optional(),
    popup: PartRef.optional(),
    /** Where focus goes when the popup closes, when not back to the trigger (e.g. the trigger is removed on close). */
    returnFocusTo: PartRef.optional(),
  })
  .strict();
export type BehaviourBinding = z.infer<typeof BehaviourBinding>;

const Digest = z.string().regex(/^[0-9a-f]{12,64}$/, "expected a hex digest");
const RunId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "expected a run id");
const RoutePath = z.string().regex(/^\//, "expected a route starting with /");
const Viewport = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict();
const Box = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();
/**
 * Evidence lives under `.youi/`: a project-relative path starting `.youi/`, forward slashes only,
 * each segment of letters, digits, `.`, `_` and `-` that does not start with a dot. So no `..` or
 * `.` segment, no drive letter (`C:`), no leading slash, backslash or UNC prefix. A pattern, not a
 * refinement, so the published JSON Schema refuses exactly what this does. (Resolving it against
 * the real `.youi/`, symlinks included, happens where evidence is read and written.)
 */
export const EVIDENCE_PATH = /^\.youi\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/)*[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const EvidencePath = z.string().regex(EVIDENCE_PATH, "expected a path under .youi/ with forward slashes, no .. and no drive or leading slash");

/**
 * Which popup a result is about. Matching across runs uses route, pattern, component and accessible
 * name (plus ordinal only when several targets share all four); file, line, domPath and box are for
 * display, so moving code does not break a match. Positions are only ever what locating found.
 */
export const BehaviourTarget = z
  .object({
    route: RoutePath,
    pattern: BehaviourPattern,
    /** The component that renders the trigger (its name, e.g. `Menu`), or null for plain markup. */
    component: z.string().min(1).nullable(),
    accessibleName: z.string(),
    /** 0-based, only when several targets share route, pattern, component and name. */
    ordinal: z.number().int().nonnegative().optional(),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    domPath: z.string().min(1).optional(),
    box: Box.optional(),
  })
  .strict();
export type BehaviourTarget = z.infer<typeof BehaviourTarget>;

/**
 * passed / failed: the check ran and decided. not-applicable: the check does not apply to this
 * pattern (never a pass). incomplete: it could not tell (popup never identified, the page tried to
 * leave, over budget). error: the probe itself failed. Only `passed` ever counts as clean.
 */
export const BEHAVIOUR_RESULT_STATES = ["passed", "failed", "not-applicable", "incomplete", "error"] as const;

export const BehaviourResult = z
  .object({
    /** The probe run that made this result. */
    runId: RunId,
    at: z.iso.datetime({ offset: true }),
    viewport: Viewport,
    route: RoutePath,
    rule: ElementId,
    target: BehaviourTarget,
    pattern: BehaviourPattern,
    check: BehaviourCheckId,
    state: z.enum(BEHAVIOUR_RESULT_STATES),
    /** One plain sentence: what happened. */
    why: z.string().min(1),
    /** What to do: a concrete fix for a failure, or the `Next:` step when it could not tell. */
    fix: z.string().min(1),
    /** Facts that are not pass or fail (Home moves to the first item: yes; arrow keys wrap). */
    info: z.array(z.string().min(1)).default([]),
    /**
     * After the trigger was clicked the page asked for data (fetch, XHR, EventSource, a worker's
     * request…) and the probe blocked it: this was tested with the popup's data blocked.
     */
    dataBlocked: z.boolean().default(false),
    /** Screenshots, as project-relative paths under `.youi/`. */
    evidence: z.array(EvidencePath).default([]),
    /**
     * What this result was made against. It is stale (shown as stale, never counted as a pass)
     * when any part differs now, or when its route or viewport does.
     */
    freshness: z
      .object({
        /** Digest of the rule file and its options. */
        rule: Digest,
        /** The youiyoux version that ran the probe. */
        tool: z.string().min(1),
        /** The exact origin probed (scheme, host and port). */
        origin: z.url(),
        /** Digest of the `screens.json` behaviour config. */
        config: Digest,
        /** Digest of every source file the scan covers, plus CSS, package.json and the lockfile. */
        app: Digest,
      })
      .strict(),
  })
  .strict()
  .refine((r) => r.target.route === r.route && r.target.pattern === r.pattern, "target route and pattern must match the result's");
export type BehaviourResult = z.infer<typeof BehaviourResult>;

/** The hosts a probe may open: this machine only (as a URL's hostname spells them). */
export const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/**
 * `screens.json`'s `behaviour` block: consent to probe, bound to one exact origin (scheme, host and
 * port), never a boolean. It holds only while `allowedOrigin` is there, the origin of
 * `screens.json`'s `base` is exactly it, and it is on this machine; the field being there is never
 * enough (a capture can move `base`). Switched off, the block keeps only its `generation`, which
 * every switch (on, off, or consent dropped by a move) raises by one, so a running probe can tell
 * that consent changed under it, even if it was switched back on.
 */
export const BehaviourConsent = z.object({ allowedOrigin: z.string().min(1).max(200).optional(), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0) }).strict();
export type BehaviourConsent = z.infer<typeof BehaviourConsent>;

export const BEHAVIOUR_ROUTE_SCHEMA = "youiyoux.behaviour/v1";

/**
 * One route's last probe run, as `.youi/behaviour/<route-hash>.json` keeps it. `incomplete` with a
 * `why` when the route could not be probed at all (it needs a sign-in, it moved away as it loaded);
 * `coverage` says what was and wasn't looked at. Only `results` with state `passed` ever count as clean.
 */
export const BehaviourRouteRun = z
  .object({
    schema: z.literal(BEHAVIOUR_ROUTE_SCHEMA),
    route: RoutePath,
    runId: RunId,
    at: z.iso.datetime({ offset: true }),
    /** The exact origin probed. */
    origin: z.url(),
    viewport: Viewport,
    state: z.enum(["probed", "incomplete"]),
    /** Why the route as a whole could not be probed, and what to do; null when it was. */
    why: z.string().min(1).nullable(),
    fix: z.string().min(1).nullable(),
    /** What was looked at, in a sentence (no popups found is said, never left as a zero). */
    coverage: z.string().min(1),
    results: z.array(BehaviourResult),
  })
  .strict()
  .refine((r) => r.results.every((x) => x.route === r.route && x.runId === r.runId), "every result must be this run's, on this route")
  .refine((r) => (r.state === "incomplete") === (r.why !== null) && (r.why === null) === (r.fix === null), "an incomplete run says why and what to do; a probed one doesn't");
export type BehaviourRouteRun = z.infer<typeof BehaviourRouteRun>;
