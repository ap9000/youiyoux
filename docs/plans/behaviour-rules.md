# Behaviour rules — plan

Status: plan v3, 2026-11-12, branch `behaviour-rules-plan`. Codex round 1: GO WITH CHANGES, 15 findings → v2.
Codex round 2: GO WITH CHANGES (9 closed, 6 partial, 6 new) → v3, folded in and checked against the code by Claude
(review budget: 2 rounds per arc; see "v3 changes" at the end). Waiting on Alex's go-ahead to build.

Alex (2026-11-12): youiyoux is not just a scanner — it is the rules reference, the surface to edit the UI, and the
way changes reach the apps we work on. Prompted by vercel-labs/ui (UI SDK: headless behaviours for agents — focus
recovery, roving focus, dismissal, modal, listbox keyboard, typeahead).

## What and why

Every youiyoux rule today is about how things **look** or which component is used: the `youi` engine (`raw-color`,
`native-element`, `lookalike-component`, `arbitrary-value`, `prop-values`), `ast-grep`, or `advisory`, all static
(`packages/scanner/src/checks.ts:379-416`). Nothing checks how things **behave**: whether a menu closes on Esc, whether
focus goes back to the button that opened it, whether arrow keys move through a menu. `render` runs axe on static
markup with no JavaScript (`specimens/render.ts:114-143`, `shots.ts:314`), so it can't see any of this.

These are the bugs agents ship most often in hand-built popups, and the first ones a keyboard user hits. This plan
adds them to all three parts of youiyoux:

1. **Reference** — behaviour rules in the same `*.rule.yaml` files (statement, rationale, agent text), carried to
   AGENTS.md / DESIGN.md / SKILL.md and `system_get_rules` like every other rule.
2. **Edit surface** — a **Behaviour** tab beside Edit and Comment on a picked component.
3. **Changes reach the app** — a failed behaviour files a change request whose acceptance is a fresh passing run of
   the same check on the same target.

v1 covers four popup patterns only (below). Not grids, trees, tabs, sliders, drag and drop, typeahead, disclosure.

## Patterns, not one rule for everything

Each check is defined per **pattern**, following the WAI-ARIA Authoring Practices (APG). A target has exactly one
pattern; a check that doesn't apply to a pattern is `not-applicable`, never passed.

| Pattern | Trigger | Popup | Notes |
| --- | --- | --- | --- |
| `menu-button` | `button` with `aria-haspopup` = `menu`/`true` | `role=menu` | `aria-expanded` required on the trigger; `aria-controls` optional, but if present must resolve to the menu |
| `combobox-listbox` | `role=combobox` (focus stays on it) | `role=listbox` | `aria-expanded` + `aria-controls` → the listbox; active option via `aria-activedescendant` |
| `modal-dialog` | any button that opens it | `role=dialog`/`alertdialog` with `aria-modal=true`, or native `<dialog>` opened with `showModal()` | no `aria-expanded` requirement on the launcher; `<dialog open>` without `showModal()` is **not** modal |
| `popover` | `popovertarget`, or `aria-expanded` + `aria-controls` | native `[popover]` or the controlled element | native `popovertarget` supplies the relationship implicitly (passes `trigger-state`) |

How a target's pattern is known, in order:

1. **Contract binding.** `ComponentContract.a11y` gains `behaviour?: { pattern, trigger?: PartRef, popup?: PartRef,
   returnFocusTo?: PartRef }` where `PartRef` names a part by `data-part`/`data-slot` value or ARIA role inside the
   component's root. This locates the real trigger and popup parts, not just "this component is a menu".
2. **The DOM's own claims**, matched against the table above. An element that matches no pattern is not a target.

Coverage is stated honestly: a screen with none says **"No declared popups found; popups without these markers were
not assessed."** No count of "undeclared openers" (finding 10: finding them would need unsafe exploration).

## Checks (v1)

Every check runs as its own **scenario** from a fresh state (below). "Open" means: click the trigger, then wait until a
popup is **positively identified** (the controlled/related element, or for a contract binding its popup part, is
present, visible, not `inert`, not `aria-hidden`), polling within the open budget (2 s). If it never opens, every check
of that target is `incomplete` ("clicking the button didn't open anything we could identify"), never passed.

"Closed" means the popup is removed, `display:none`/`visibility:hidden`, `hidden`, `inert`, `aria-hidden=true`, a
closed native popover, or a closed `<dialog>` — polled within the close budget (1.5 s, allowing exit animations).

**Effective focus** = `document.activeElement` (through shadow roots), except that when it is a `combobox` or
`listbox` with `aria-activedescendant`, it is the referenced element — which must exist, belong to the widget
(inside it or in the element its `aria-controls` names) and not be `aria-disabled`.

| id | Patterns | Passes when | Fails when | Can't tell (incomplete) |
| --- | --- | --- | --- | --- |
| `trigger-state` | menu-button, combobox-listbox, popover | the pattern's required attributes are present and correct closed and open (`aria-expanded` false→true; `aria-haspopup` value; `aria-controls` resolves to the identified popup) | a required attribute is missing, wrong, or doesn't change | popup never identified |
| `dismiss-escape` | all four | after Esc (sent with effective focus inside the popup, or on the combobox) the popup is closed | still open after the close budget | focus couldn't be placed inside |
| `focus-into` | menu-button, modal-dialog | menu: effective focus is a `menuitem*` in the menu (container focus alone fails). dialog: effective focus is inside the dialog (a tabbable inside, or the dialog itself with `tabindex=-1`, both allowed by APG) | focus stayed on the trigger or left the popup | — |
| `focus-into` | combobox-listbox | not applicable (DOM focus stays on the combobox by design) | — | — |
| `focus-return` | menu-button, modal-dialog, popover | after Esc closes it, effective focus is the trigger, or the contract's `returnFocusTo` part | focus is on `body` or elsewhere while the trigger still exists | the trigger was removed and no `returnFocusTo` is declared ("the button that opened it is gone; declare where focus should go") |
| `focus-trap` | modal-dialog | with N = tabbables inside: N Tabs visit each once in order then wrap to the first; N Shift+Tabs the reverse; N=0: the dialog itself keeps focus; N=1: it keeps focus. Native `showModal()` passes the containment part by definition but still checks order | focus leaves, or Tab doesn't move between tabbables (a dialog that swallows every Tab fails) | nested popup open inside it |
| `arrow-keys` | menu-button (vertical), combobox-listbox | ArrowDown/Up move effective focus to the next/previous **enabled** item in document order; at the ends both wrapping and staying are accepted (reported as which) | focus doesn't move, moves to a disabled item, or to something outside the widget | orientation is horizontal (`aria-orientation`): v1 says "horizontal menus not checked yet" |

Home/End are reported as information only ("Home moves to the first item: yes/no"), never a failure: APG makes them
optional for listboxes. Submenus: v1 tests the top-level menu only and says so.

**Opening** is by mouse click only in v1. Keyboard activation of triggers (Enter/Space/ArrowDown on a menu button) is
**not verified in v1**, and results say so.

## Where a probe runs

Behaviour needs **trusted** input (a synthetic `KeyboardEvent` doesn't move focus on Tab), so probes don't run in the
person's live iframe. The service (`packages/workflow`) drives the existing headless Chromium (`launchBrowser`,
`packages/detect/src/site.ts:80`) through Playwright.

**Locating** does not use the bridge: `bridge.ts:96` does nothing unframed and answers only its authenticated parent.
Instead the probe injects `locateInPage` (`screens/locate.ts`) with `page.evaluate`, then maps its frames to file:line
through the service's existing resolver (`packages/workflow/src/live.ts`, same no-redirect source-map fetching).

**Target identity** across rerenders, portals, repeats and ordinary code edits: matching uses `{ route, pattern,
component, accessibleName }`, plus `ordinal` only when several targets share all four. `file`/`line`/`domPath` are
display only, so moving a line or editing nearby code doesn't break a match. If a match is ambiguous (repeats
reordered, names duplicated) or missing, the result is `incomplete` ("several menus are called 'More' here; name them
apart or declare a contract binding"), never matched by guess.

**Popup identification**: from the trigger's relationship (`aria-controls`, `popovertarget`) or the contract's popup
part. Without either (a modal dialog or menu with no `aria-controls`), the popup is the **single** element of the
pattern's role that is visible after the click and was not visible before; zero or several → `incomplete`
("couldn't tell which of 2 dialogs this button opened"). Never by coordinates.

**Fresh state per scenario**: each (target, check) runs in a new page in the same throwaway browser context: load the
route, wait for network idle (bounded), find the target by identity, open, act, observe. One scenario's dismissal can't
leave the next one testing a closed popup.

## Probe safety

A probe clicks real buttons in a real running app. Blocking network writes is **mitigation, not a guarantee**: GET
handlers can mutate, service workers and WebSockets bypass page routes (finding 1). So:

- **Opt-in per app origin, stated plainly.** Probing needs `screens.json` → `behaviour: { allowedOrigin:
  "http://localhost:5173" }` — consent is bound to that exact origin, not a boolean. It is written by an authenticated
  service write (`POST /api/screens/behaviour`, `x-youi-session` + loopback Origin, Zod-validated, `writeFileAtomic`,
  the origin taken from the current `base`, never from the request body) after the person's click on the hub's words:
  "Probes click buttons that open menus and dialogs in your running app. Use a dev app with test data." Or by hand.
  When `base`'s origin differs from `allowedOrigin` (capture rewrites `base`, `capture.ts:216-217`, and spreads the
  rest), there is no consent: the tab asks again. No consent → the Behaviour tab explains and offers the switch;
  `behave` refuses with the same words.
- **Exact origin.** The permitted origin is the scheme+host+port of the resolved `base`, which must be loopback
  (`127.0.0.1`, `::1`, `localhost`). Each screen URL is resolved and must stay on that origin (absolute screen paths to
  elsewhere are refused). Every request is checked against it at the **context** level, installed before the first
  load: other origins (including other localhost ports) are aborted.
- **No writes leave.** Context-level route aborts every request that isn't GET/HEAD/OPTIONS; service workers are
  blocked (`serviceWorkers: "block"`); **every** WebSocket is blocked, the dev server's hot-reload socket included (no
  exception: its messages can't be shown to carry no app data). A dev client that reacts to the lost socket by
  reloading is caught by the navigation guard and reported; fixtures prove Vite and Next dev pages still probe with
  their socket blocked. An abort marks the scenario `incomplete` with "the page tried to send a POST to /api/…; nothing
  was sent" (path shown, query string dropped).
- **After the click, no data requests** (Alex, finding 1: block data requests after the click, keep testing, label
  the result). Before the trigger is clicked the page loads as it does when the person opens it (unsafe methods
  and other origins already refused). After a trigger is clicked, the page may load only its own scripts, styles,
  images, fonts and media; every data request is blocked and the result says it was tested with its data blocked.
  Enforced twice: the context route allows only GET/HEAD of resource type script, stylesheet, image, font or media
  (fetch, XHR, EventSource, WebSocket, beacons, manifests, documents, anything unclassified and every worker's
  request are refused); the fence, in its after-click mode, allows only GET/HEAD whose `Sec-Fetch-Dest` is script,
  style, image, font, audio, video or track (set by the browser, not by page script). A blocked data request doesn't
  make the scenario incomplete: it adds the info line "the popup asked for data when it opened (GET /path); it was
  blocked, so this was tested with its data blocked" and `dataBlocked: true` to every result of that scenario. A
  popup that never opens because its data was blocked is the usual "didn't open" incomplete, naming the request.
  The consent words still say: use a dev app with test data. **Residual, accepted:** an app that changes data on a
  GET for a static file (an image or script URL that records or mutates) is out of reach of these guards.
- **Stays on the screen.** Cross-document navigations are aborted before they leave (route on `document` requests);
  `window.open` is replaced by a no-op in an init script and the context refuses new pages; SPA changes (history/hash)
  are detected after every step by comparing `location` with the scenario's start URL → `incomplete`.
- **Clicks only triggers, presses only safe keys.** Only identified triggers are clicked, never an item inside a
  popup. Keys: Esc, Tab, Shift+Tab, ArrowUp/Down, Home, End. Never Enter, Space, or typing.
- **Not signed in, in v1.** The probe context has no cookies or storage. A screen that redirects to sign-in or shows
  a sign-in form is `incomplete`: "this screen needs a signed-in session; probing signed-in screens isn't supported
  yet." (Storage-state import is deferred: finding 3 — it hands credentials to app JavaScript and needs its own design
  with test accounts, origin-scoped state and a validated config path.)
- **Shareable output is redacted.** Results keep accessible names, paths and screenshots locally under `.youi/`; the
  existing redaction for shareable output applies to anything exported (step summary, report, card): no query
  strings, no screenshot unless asked.
- **The Run endpoint** is a service write: `x-youi-session` + loopback Origin like every other write
  (`http.ts:155-163`). It takes a route and an optional target identity, never a URL, path or file.
- **Bounded.** 20 targets per route, 5 s per scenario, 300 s per route (90 s until slice 2, whose dismiss-escape runs a
  control scenario besides the test; 150 s until slice 3, where all six checks make up to seven scenarios per target); over budget = `incomplete` naming untested
  targets. Runs only on request (tab Run, `youiyoux behave`, MCP `ui_behave`), never on scan or in the background.

## Results and rule execution

**`BehaviourResult` is the canonical record** (finding 11; one Zod schema, `pnpm schemas`). It is not converted into
`Violation` (which requires file/line/column/text). Fields: `runId`, `at`, `viewport`, `route`, `target` (identity
above; file/line optional, never invented), `pattern`, `check`, `state: passed | failed | not-applicable |
incomplete | error`, `why`, `fix`, `info[]` (Home/End, wrap/stay), evidence screenshot paths, and a **freshness key**.
Locating finds the JSX call site, not the popup's implementation (imported focus helpers, CSS), so the key is
deliberately conservative: digest of the rule file + options, the youiyoux version, the allowed origin + route path +
`screens.json` behaviour config, the viewport, and an **app fingerprint** = content hashes of every source file the
scan covers (the project's scanned module set, plus CSS and `package.json`/lockfile). Any source change makes every
behaviour result stale; a target with no file:line is covered by the same fingerprint. A result is **stale** when any
part of its key differs now; stale results are shown as stale and never count as passes. (Coarse by design: a
re-run is cheap, a wrong pass isn't.)

Stored at `.youi/behaviour/<route-hash>.json` with `writeFileAtomic`.

**What the app fingerprint covers** (slice 2 review): every project file git lists (tracked, and untracked not
ignored; else a bounded walk), without node_modules, build output or `.youi/`; every lockfile up to the repository's
top, with the package managers' install state there (pnpm's `node_modules/.modules.yaml` and `.pnpm/lock.yaml`, npm's
`node_modules/.package-lock.json`, yarn's `node_modules/.yarn-state.yml` and `.yarn/install-state.gz`: transitive
versions and integrity); each installed direct dependency's package.json (name, version, integrity); and the files
screens.json's `behaviour.inputs` globs name, through a link only when it stays inside the project (content hashed,
never stored or printed). The contract bindings (every component's `a11y.behaviour`) are their own part of the key.
When the file list can't be the whole app (git failing in a repository, the 20,000-file walk cap, a folder or file
that can't be read, an input leading outside the project), the fingerprint is incomplete: nothing can be fresh
against it, `behave` refuses with why and `check` says why per route. Residuals: environment variables set outside
files, and hand edits inside node_modules, aren't tracked.

**Integrity is checked separately from freshness** (slice 2 review). The freshness key proves what a result was made
against, not that the stored file is whole or authentic: anyone who can write `.youi/` can write any file. So the run
also stores every target it found (`targets`), and a rule counts on a route only with exactly one result per target
and `not-applicable` only where the pattern table says the check doesn't apply; anything else is that route
incomplete. A deliberate forgery by a process on the same account remains out of scope (as for evidence paths).

**Presentation merges**, it doesn't convert: rule screens (`RulesScreen.tsx`, `RuleDetail.tsx`), the per-screen
"Rule issues" section (`ScreenDetail.tsx:447`) and `IssueCounts.tsx` read violations and behaviour results through
one adapter that keeps the two kinds distinct (a behaviour row shows route + target, file:line when known).

**Execution semantics** (finding 12), landing before any check:

- `RuleRun.state` gains `incomplete` (schema change), and `failedChecks`/`check.ts` treat it like `unsupported`/`error`:
  the overall result is incomplete, never clean.
- A behaviour rule's run for `check` / `check --diff` comes from stored results only: `ran` when every route in the
  **denominator** has a fresh complete result; `incomplete` otherwise, naming the routes. Denominator = routes in
  `screens.json` (all, or those listed under `behaviour.routes` when set). `check` never runs probes.
- Behaviour rules are **opt-in**: none are added to a system unless the person adds them (starter rules are offered,
  not installed). So projects that never run `behave` aren't made noisy.
- Engine registration touches every place a check is enumerated: `ruleExecution`, `BUILT_IN_CHECKS`-style table,
  `capabilities.ts` (`ruleCapability`/`checkCapabilities`, so the hub's RuleForm can pick it), `agents.ts` (agent text
  says how to verify), `check-render.ts` renderers, `check-diff.ts` (a behaviour finding is `kind: "behaviour"`, compared
  by target identity, not file:line), baselines.
- **Failures count, not just display.** `check.ts:80-87` counts only `Violation`s; it gains `behaviour` (fresh failed
  results for wanted, enabled rules) and `errors += behaviour failures of error severity` (warnings counted
  alongside); baselines/`--quiet`/`--rule` filter them the same way. `incomplete` also becomes true when a behaviour
  rule's run is `incomplete`.
- **`preview.ts:33` `notRunReason`** treats `incomplete` like `unsupported`/`error`, and a behaviour draft rule's
  preview says "behaviour rules are checked by a probe run, not on the snapshot" rather than reading as zero
  findings. Every other `RuleRun.state` consumer is found by grep in slice 0 and listed in the commit.
- **Exit matrix** (`check`'s existing rules kept): `check` and `behave` → 1 when there is an error-severity failure or
  the result is incomplete, else 0; `check --diff` → 0 unless `--strict`, as today.

## Fix text and UI SDK

Each failure's `fix` names the pattern in plain words and is pattern-aware ("when the menu closes with Esc, move focus
back to the button that opened it"; for a removed trigger, "declare where focus should go"). If the project's
`package.json` already depends on `@ui-sdk/*`, it also names the matching piece (`createFocusRecovery`, popup
dismissal, roving focus) from a small static table. youiyoux never suggests adding a dependency.

## Change requests

`fileRequest()` can't attach acceptance today: `POST /api/requests` takes kind/body/target and
`RequestStore.create()` (`requests.ts:276-294`) builds the task itself (finding 13). So:

- `POST /api/requests` accepts an optional `behaviour: { runId, resultIndex }`. The **server** loads that stored
  result, refuses unless it exists, is `failed` and fresh, and builds the task's acceptance itself:
  `{ statement: "<check> passes for <target> on <route> in a run newer than this request", evidence: ["check"] }`
  (the existing evidence array schema).
- `RequestDoc` (`core/src/requests.ts:108`) gains `behaviour?: { rule, check, target (identity), runId, failedAt }`
  — machine-readable, set only by the server from the stored result (the request's `target` is derived from it
  server-side too, not taken from the body).
- **`RequestStore.setStatus()` enforces it** (`workflow/src/requests.ts:339`), so HTTP, MCP and CLI share one rule:
  moving a behaviour request to `addressed` requires a stored, fresh, `passed` result for the same rule, check and
  target identity from a run newer than the request; otherwise `conflict` with "run `youiyoux behave --route <r>`
  first; the last run still fails" (or "…has no newer run"). A person closing it is still a person's call.

## UI

**Behaviour tab** (`ScreensCanvas.tsx:605-635`, `Segmented<"edit"|"behaviour"|"comment">`):

- Scope is the picked component: **Run on this component** probes its targets only. The route-wide **Run on this
  screen** lives in the screen's detail, so the two scopes are never confused.
- One row per check: name, result as text plus a small sage/clay dot (no fills, `color.status-only`), the `why`
  sentence and the `fix` always visible on a failure. Evidence (before/after screenshots, info lines) behind an
  expandable **Show evidence** button — keyboard and touch reachable, not hover-only.
- While running: "Testing 2 popups on /flows…". Shows when the result was made; stale results say "the code or rule
  changed since this run" and are not counted.
- No opt-in yet: the explanation and the switch (above), nothing else.
- A failed row: **File as change request** (server-built acceptance as above).
- Checked in a real browser at desktop and phone widths with long `why` text, keyboard-only use, and service/probe
  errors before sign-off (not jsdom only).

## CLI, MCP, agents

- `youiyoux behave [--route /x]` — probes the opted-in app's routes (or one), prints results with the same text /
  GitHub annotation / step-summary renderers as `check`.
- MCP `ui_behave {route, target?}` → results, so an agent verifies its own fix; added to `MCP_TOOLS`.
- `agentsBlock` writes behaviour rules like any rule, with "verify with `youiyoux behave --route <r>` (or `ui_behave`)".

## Slices

0. **Contracts and semantics** — schema arm `engine: behaviour` with the closed check list; `BehaviourResult`;
   `RuleRun` `incomplete`; contract `a11y.behaviour` binding; registration in capabilities/agents/renderers/diff with
   "not run yet" states. No browser.
1. **Guarded runner on fixtures** — opt-in, origin/route/WebSocket/service-worker/navigation/popup guards, fresh
   scenarios, target identity, locate + resolve; adversarial tests. No checks yet beyond "open and identify".
   Evidence paths: the schema only admits `.youi/…` with plain segments (slice 0); writing and reading evidence
   must also resolve each path against the real `.youi/` (symlinks included) and refuse anything that escapes.
   Check and use are tied (Alex, finding 5: cheap guard, accept the rest): reads open with `O_NOFOLLOW` and refuse a
   handle whose device/inode isn't the checked file's; writes go to an exclusive `O_NOFOLLOW` temp file in the
   checked folder, then rename, then a `realpath` re-check (outside the real `.youi/` → removed and refused).
   Residual, out of scope: a process on the same account that swaps a parent folder between the check and the open
   (it could already change the files themselves).
2. **One check end to end** — `dismiss-escape` through `behave`, storage, freshness/stale, `check` reading stored
   results, exit codes.
3. **The other five checks** — with the pattern table, effective focus, budgets; fixtures per pattern.
4. **Tab, change requests, MCP** — the Behaviour tab, server-built acceptance, `ui_behave`.
5. **Starter rules and docs** — offered (not installed) rules, commands.md, agents.md, a README use case with real
   screenshots; the hub's own rules adopt them (dogfood).

Each slice ships with tests that fail without it; `pnpm typecheck`, `pnpm test`, `cd apps/web && pnpm test && pnpm
build`, `node packages/cli/bin/youi.js schema --check`.

## Tests

- **Fixtures** (served by the test, no network), each pattern with good and bad versions: menu that ignores Esc,
  loses focus on close, focuses the container only, skips disabled items wrongly; combobox with valid and dangling
  `aria-activedescendant` and a portalled listbox; modal without trap, one that swallows Tab, zero/one tabbable,
  native `showModal()` vs `<dialog open>`; native popover; async open (300 ms), exit animation (400 ms), delayed focus
  restore; trigger removed on close with and without `returnFocusTo`; nested popup; repeated identical components.
- **Safety (each bypass tested):** POST on open → aborted, server saw nothing; a GET to another localhost port →
  aborted; a service worker registration → blocked; an app WebSocket → blocked, HMR socket allowed only on the
  detected path; cross-document navigation → aborted before leaving; `history.pushState` → detected; `window.open` →
  no page; items inside popups never clicked; Enter/Space/typing never sent (recorded key log); non-loopback base and
  off-origin screen URL refused; no opt-in → refused; Run endpoint without session key → 403; budget overrun →
  incomplete naming targets; query strings never in output.
- **Semantics:** unprobed or stale route → rule `incomplete` in `check`; stale pass never counted; `check --diff`
  compares by target identity; request acceptance refuses a non-failed or stale result; addressed requires a newer
  fresh pass.
- **Hub:** jsdom for rows, scope, stale, opt-in, filed request words; browser check at desktop/phone widths.

## Not in this plan

- Signed-in screens (storage state) — own design later.
- Keyboard activation of triggers, horizontal menus, submenus, typeahead, grids, trees, tabs, sliders, disclosure.
- Behaviour checks in CI against a deployed preview (needs a running app; later, with the hosted hub).
- Writing behaviour fixes to code from the hub (a change request instead).

## v2 changes (Codex round 1: GO WITH CHANGES, 15 findings)

1. Safety is mitigation, not a guarantee → per-app opt-in for a dev app with test data; context-level guards before
   load; service workers and app WebSockets blocked; each bypass tested.
2. Exact permitted origin on every request; off-origin screen URLs refused; navigations aborted before leaving;
   `window.open` neutralised; SPA changes detected; session key on Run.
3. Storage state removed from v1; signed-in screens are `incomplete` with why.
4. Locating uses `locateInPage` via Playwright + the service resolver, not the bridge; stable target identity defined.
5. `trigger-state` per pattern (menu-button / combobox-listbox / popover); dialog launchers exempt; native popover
   relationship accepted; relationships validated.
6. Effective focus through `aria-activedescendant`; container-only focus fails for menus; `focus-return` accepts a
   declared `returnFocusTo` and is "can't tell" when the trigger is gone.
7. `arrow-keys` per pattern and orientation; disabled items skipped; wrap or stay both accepted; Home/End info only;
   destination must belong to the widget.
8. `focus-trap` from the actual tabbable count, both directions, wrap; zero/one tabbable defined; Tab-swallowing fails;
   `showModal()` vs `<dialog open>`.
9. Fresh scenario per check; positive identification of open; polling budgets for async open and exit animation;
   failed open makes dependent checks incomplete.
10. No "undeclared openers" count; honest coverage sentence; contract part bindings.
11. `BehaviourResult` canonical, merged at presentation; no invented positions; freshness key.
12. `RuleRun` `incomplete`; full registration list; opt-in rules; denominator and exit codes; stale passes invalid.
13. Server-built acceptance from a validated stored result; fix proven only by a newer fresh pass.
14. Slices re-cut: semantics first, guarded runner second, one check end to end, then the rest; adversarial and
    timing fixtures; keyboard activation explicitly out of v1.
15. Evidence behind a keyboard/touch button, failures always visible, component vs screen scope separated, real
    browser checks at both widths.

## v3 changes (Codex round 2: GO WITH CHANGES; folded in by Claude, checked against the code)

- **HMR socket (high):** the exception is removed; all WebSockets blocked; dev pages proven to probe without it.
- **Freshness (high):** app-wide source fingerprint + config, route and viewport in the key; any source change makes
  results stale; unmapped targets covered.
- **Exit codes (high):** behaviour failures counted in `check`'s `errors` by severity (`check.ts:80-87`); exact exit
  matrix stated.
- **Acceptance enforcement (high):** `RequestDoc.behaviour` linkage set by the server; `RequestStore.setStatus()`
  enforces a newer fresh pass for every caller.
- **`RuleRun.incomplete` consumers (medium):** `preview.notRunReason` (`preview.ts:33`) and every other consumer
  updated in slice 0.
- **Opt-in (medium):** consent bound to the exact origin, written by an authenticated, validated, atomic service
  write; a changed `base` origin means no consent.
- **Partials 4 and 5:** identity matches on component + accessible name (+ ordinal), never file:line; ambiguous →
  incomplete. Popups without a relationship are identified as the single newly visible element of the pattern's role,
  else incomplete.

## Slice 1 review record (accepted by Alex, 2026-11-12)

Codex code review: round 1 NO-GO (8 findings), round 2 NO-GO (4 closed, 4 partial, 4 new). Alex decided finding 1
(block data requests after the click, keep testing, label `dataBlocked`) and finding 5 (cheap guard). The round-2 items
(lock exclusion, data blocking until page and workers are gone, hover swap, revoke during discovery, CI browser gate)
were fixed and verified by Claude: each regression test passes with its fix and fails with the pre-fix file restored.

Accepted residuals:

1. One CDP round trip between the last isolated-world check at the pointer and the press; a page timer could swap the
   target in it. The landing check reports it as incomplete, but the press has happened.
2. A writer that dies after winning the stale-lock marker but before removing the dead lock leaves both files;
   writers time out naming them for deletion by hand.
3. An app that changes data on a GET for a static file (image, script, style, font, media) is out of reach.
4. A process on the same account swapping a parent folder between the check and the open is out of scope.
5. Component names and source frames are read from the page's main world and can be forged: identity and display
   only, never what may be clicked.
6. https dev servers are refused (the fence can't see inside a tunnel).

## Slice 2 review record (2026-11-12) (accepted by Alex, 2026-11-12)

Codex code review: round 1 NO-GO (7 findings), round 2 NO-GO (5 closed: losing a relationship read as closed,
stored completeness trusted, contract bindings outside the key, consent read before focus, an empty denominator
passing; 2 partial; 3 new). All fixed with regression tests, each shown to fail without its fix (file reverts or
one-line mutations):

- Focus can close the popup: a pre-key recheck of the very popup and focus, plus a **control** scenario (the same
  steps, no key, the popup watched for the close budget); a dismiss-escape pass stands only when the control kept it
  open. A passing dismiss-escape costs two scenarios, so the route budget went from 90 s to 150 s.
- Closed is judged on the identified element; a hidden or removed popup is reconciled by identity (id and role, or
  the contract part) and by anything new of its kind since the key; never closed by default.
- Integrity: each run stores its targets; a rule counts on a route only with one result per target and
  `not-applicable` only where the pattern table says so; failures that stand on their own still count.
- Freshness: the contract-bindings digest; the app fingerprint over the project's files (git, or a bounded walk),
  every lockfile and install-state file up to the repository's top, installed direct dependencies and
  `behaviour.inputs`; an enumeration that can't be the whole app makes it incomplete, so nothing is fresh.
- Consent is read after focus is placed, immediately before the key; behave refuses with no screens; the no-consent
  words name the screens.json edit (the hub's switch arrives with slice 4).
- The screens.json lock race test covers an empty and a dead holder on every runner (a start barrier), not by timing.

Accepted residuals:

1. Environment variables set outside files aren't part of the fingerprint.
2. Hand edits inside node_modules aren't tracked (installed versions and the install state are).
3. One CDP round trip between the last pre-key check (popup, focus, consent) and the Escape press; a page timer
   could change things in it (as for the click, slice 1 residual 1).
4. A deliberate forgery of `.youi/` by a process on the same account is out of scope: freshness proves inputs,
   integrity proves completeness, neither proves authenticity.
