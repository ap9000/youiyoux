export { behaviourConsent, withBase, CONSENT_WORDS, describeUrl, probeOrigin, requestVerdict, screenUrl, SIGN_IN_FIX, SIGN_IN_WORDS, type Consent } from "./guards.ts";
export { startFence, type Fence, type FenceRefusal } from "./fence.ts";
export { ambiguousWords, matchTarget, withOrdinals, type TargetKey } from "./identity.ts";
export type { ContractBinding, FoundTarget, PopupFound } from "./in-page.ts";
export { openAndIdentify, type GuardEvent, type ProbePage, type ScenarioOutcome } from "./scenario.ts";
export { PROBE_BUDGETS, probeRoute, type ProbeBudgets, type ProbedTarget, type ProbeRouteOptions, type RouteProbe, type TargetScenario } from "./probe.ts";
