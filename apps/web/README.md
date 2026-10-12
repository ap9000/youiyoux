# YouIyouX web

The design language hub: find an element, see its contract, tokens and rules, preview the real component, and see exactly where it lives in each project. Local-only for now: no accounts. Everything reads a static snapshot except Rules, Style (saving) and Changes, which talk to the local workflow service that `youi ui --project` starts.

```sh
pnpm install        # at the repository root (apps/* is in the workspace)
cd apps/web
pnpm dev            # http://localhost:5173, on the demo system
```

Or, from anywhere, with the CLI:

```sh
youi ui                                              # the demo system
youi ui --design ~/src/acme-design                   # your design repo
youi ui --project ~/src/acme-app                     # plus where it is used in a product (read-only scan)
youi ui --project ~/src/acme-app --config ~/src/acme-design/acme-app.youi.json   # config kept outside the product
youi ui --project ~/src/acme-design/pilot/acme-app --root ~/src/acme-app            # the same, from the config's directory
youi ui --config ~/src/acme-design/pilot/acme-app/youi.project.json --root ~/src/acme-app   # the usage map, without the rule editor
youi ui --detect .youi/detect/detect.json            # plus a youi detect report on Library > Stack
```

The hub shows one design system at a time, read from a snapshot directory. The committed default (`snapshot/`) is the made-up demo system, so `pnpm dev` works on its own and the tool repo holds no product's data. `youi ui` with a system named writes its snapshot to `.hub/` (gitignored) and starts the dev server on that instead, so pointing the hub at a real system never changes the checkout.

Rules and Changes are live rather than a snapshot when the rule editor runs: `youi ui --project <dir>` starts it beside the dev server, which proxies `/api` to it.

## Screens

The nav rail has three labelled groups: **System** (Overview, Components, Tokens, Rules, Screens: approved elements, their rules and live usage; what products build with), **Library** (Browse, Inventory, Stack, Sources: what is ingested or detected from outside, to browse and propose; never built with) and **Work** (Style, Changes). Access stays reachable at `/access`.

| Route | What it is |
| --- | --- |
| `/` | Home: the system, where it lives, rule health, live speed numbers |
| `/elements[/<system>/<kind>/<name>[/<tab>]]` | Catalog (search, kind filter) beside the element page: Overview (live preview, uses, screens, what to look at), Usage, Contract & tokens, Rules. Tokens and rules open their own detail. |
| `/tokens[/<path>]` | Token explorer: palette overview, light and dark values, alias chain, WCAG contrast, consumers |
| `/rules[/<name>]`, `/rules/draft/<id>` | Every rule: what it checks, its level, where it is broken (counts and places). Edit and New rule open a draft on the rule's page: form, impact preview, approval, review branch. Live from the rule editor (`youi ui --project`, [guide](../../packages/workflow/README.md)); read-only from the snapshot without it |
| `/screens[/<project>/<screen>]` | Each project screen as a screenshot with its element and issue counts; a screen opens with its full screenshot, the elements it renders and the rule issues in its files (`j`/`k` step between screens) |
| `/library`, `/library/sources` | The Library (Browse): ingested candidates. Empty for now: explains the sources to come, the `library → candidate → adopted → in-use` path and what agents may do. Sources is planned |
| `/inventory` | What products already built, from `youi inventory`, laid out around each look drawn for real. **Filters**: element type, library or kit (shadcn-style for a folder of `cva()` components, Radix when its component wraps a Radix primitive, a CSS kit by its class prefix such as `.ui-*`, plain elements; named as `youi detect` names them when the hub has a detect report), project, near-duplicates only, and search by name or file. They combine, each option shows how many families it would show, and they live in the address (`?type=button&lib=css-ui&project=site&near=1&q=toolbar`), so a reload or a shared link keeps them. **Headline**: "15 families → could be ~14" (an estimate: same-element families within one tolerance step of each other count as one; the rule is under "How grouping works", with the tolerances), then the top three fixes, the near-duplicates with the most uses. **Specimen wall**: one row per role, families in cells by library or kit (an empty cell is not shown), each a tile with its specimen drawn large, a unique plain name (`Button · 32px · radius 8 · CSS kit`; when two match, the first detail that tells them apart is added), "13 uses · 4 projects" and Open. **Compare**: for each near-duplicate, its two biggest sides laid over each other with a slider to wipe between them (or side by side), over a table of height, padding, radius, font size, weight, uses and projects with the differing rows marked. **Fix list**: every way each near-duplicate is built, the files to change, and Merge into one, turned off (the hub never edits a project). **Open** a family for a drawer (a bottom sheet on a phone, which a drag down past a third of its height or a quick flick closes) headed "13 uses across 4 projects": Usage (each look's project, repo-relative `file:line` and routes), Variants (each distinct specimen, or, under States, each one default, hover, focus, pressed and disabled side by side) and Code (its HTML); Escape closes it. A compare card's States shows both sides' strips one above the other, so near-duplicates compare state by state. **States** need no script: the snapshot copies every rule of a project's sheet that uses `:hover`, `:focus-visible`, `:focus`, `:focus-within`, `:active`, `:disabled`, `[disabled]` or `[aria-disabled=true]` into a forced-state twin (`:hover` also matches `.youi-state-hover` on the element or an ancestor, at the same specificity, as Storybook's pseudo-states addon does; `:not(…)` is left alone; a `@media (hover: hover)` block gets a twin-only `(hover: none)` copy so a phone shows it too), once per sheet; a strip is one frame holding the specimen five times, each cell forcing one state, the disabled cell with `disabled` and `aria-disabled="true"` set. Because the class forces the state on everything inside the cell, a nested element's own hover style shows too (Storybook's `-all` behaviour). **Try it** on a component tile (the wall and the drawer's Variants) makes that one tile live: on click, and only then, the hub's own server (`pnpm dev`, `youi ui`, `vite preview`; `scripts/try-server.ts`) bundles just that look, with the sibling looks beside it in the same wrappers (a tab trigger and the triggers next to it), from the project's own code through the same fence as the server render (every file and import inside the project root or its own `node_modules`, real paths, esbuild's time limit), and serves it under its content hash; the tile swaps to a frame sandboxed `allow-scripts` only (never `allow-same-origin`, so the project's code runs in an opaque origin and cannot reach the hub's page, storage or cookies; it posts only its box, an unused Escape and errors, and the hub reads them only from that frame), so Radix tabs switch and a dialog closes and opens again ("Open again"). At most one tile is live; Done, Escape and scrolling it away return to the static specimen, and focus goes back to Try it; a look that does not bundle, or a host with no such server, shows one plain sentence and keeps the static specimen. Any React tabs whose pill is moved by script work the same way; an Astro or other non-React component has no browser bundle (its looks are drawn from their classes) and offers no Try it. Flags (duplicate definitions, mixed kits) and the kits and library primitives follow. Specimens are iframes at a 1280px desk width, scaled to the tile, linking the project's one stylesheet in the hub's scheme (the measured shape when there is none); frames mount near the viewport and unmount far from it, six load at once and at most 48 are mounted (visible tiles first; a tile waiting for room shows its shape), a strip past 100 tiles is virtualised. Motion: a press shrinks to 0.97 in 160 ms; the drawer comes in over 200 ms and leaves in 140 ms; wall tiles come in about 40 ms apart on first load only; only transform and opacity move; hover styles only for a mouse; reduced motion keeps the fades and drops the movement. On a phone the wall has two columns and the filters sit in a bottom sheet. Empty until a snapshot carries an inventory |
| `/library/stack` | Stack: the UI libraries a repo or website uses, from a `youi detect` report (`youi ui --detect <file>`): each library with its confidence and evidence, an element screenshot per element type, the coverage (per page crawled), and packages declared but never imported. **Add to Library** drafts a `youi.library/v1` item (seen on the site, likely the library) to copy or download; nothing is written. Without a report it explains `youi detect` |
| `/style`, `/style/draft/<id>` | Work: the style editor. Edit a system's colours (light and dark), type, spacing, radii, borders, shadows, motion (durations, easings, transitions, springs with their settle curve) and focus rings, and re-bind component states (hover, active, focus, disabled) where a contract declares them. A live preview renders the system's own demos and specimen screens (components, type and colour, space and shape, motion, focus) in light and dark, with any state pinned, and turns to the screen for the group being edited. Below 64rem (phones) it is a sticky strip under the header, light beside dark, that folds away; the token cards scroll beneath it, and the token-group tabs wrap. Colour pairs below WCAG AA are flagged as you edit (large text at 3:1, focus rings over component fills, unreadable colours as failures). Save draft (⌘S) puts the edits in Changes as a style draft. Editing and the preview work without the service; saving needs it |
| `/changes`, `/changes/<id>` | Work: the review queue for every change (rule and style drafts): draft, waiting for approval, approved, sent for review, rolled out. A style draft opens here: its edits, then the impact preview (every changed token, every site of the components that change, every direct use, contrast), approval and review branch. Approving a style draft that puts colour pairs below WCAG AA opens one confirmation naming each pair; confirming sends exactly those pairs with the approval |
| `/access` | Planned: access |

Keyboard: `⌘K` palette, `/` search the list, `j`/`k` or arrows move, `g` then `o c t r s l v d i e w` to jump, `?` for all shortcuts. In Style, ↑/↓ step a number (Shift ×10), Escape puts a field back, ⌘S saves the draft.

## Data

`pnpm data [--design <dir>] [--project <dir>] [--config <file>] [--root <dir>] [--inventory <file>] [--detect <detect.json>] [--out <dir>] [--commit <sha>]` (`scripts/snapshot.ts`) builds a snapshot with this repository's `@youiyoux/core`, `@youiyoux/tokens` and `@youiyoux/scanner`; it never runs code from the design repo. With no options it rebuilds the committed demo: `examples/demo-design`, a scan of `examples/demo-app`, and an inventory of the scanner's two inventory fixtures (`packages/scanner/test/fixtures/inventory/{console,site}`).

- `--design` is the design repo checkout (the directory holding `youi.config.json`). `--project` (or `--config` with `--root`) scans a product repo, read-only, for the usage map; its `youi.project.json` (or `--config`) also names the design repo, the system, the CSS variable prefix and the Tailwind names its components use. The snapshot records the commit that last changed the definitions it read.
- `<snapshot>/public/data/`: `manifest.json` plus content-hashed `<system>.catalog.<hash>.json` (tokens resolved per scheme, component contracts and their owned files, rules, the design narrative) and `<project>.usage.<hash>.json` (validated against `youi.usage/v1`). The browser keeps hashed files in Cache Storage, so repeat visits and offline work need only the manifest. Vite serves them beside `public/` and copies them into the build.
- `<snapshot>/public/data/<project>.screen.<hash>.webp`: the project's screens, light and dark, when it has captured them (see [Project screens](#project-screens)). The manifest lists them per route; a route without a picture shows an empty state.
- `<snapshot>/public/data/inventory.<hash>.json`: a `youi inventory` file (`--inventory`, validated against `youi.inventory/v1`; a bad file is refused with the failing field), split so the Inventory page's first paint does not grow with the library: this small index (named by the manifest's `inventory`), `inventory.<project>.<role>.<hash>.json` chunks (looks, their families and specimens), only those of the roles and projects the filters show: a role's as its row nears the screen, the rest one at a time when the browser is idle, and `inventory.extras.<hash>.json` (kits, primitives, flags), all listed in the manifest's `inventoryFiles`. `youi ui --inventory <file>` passes it through. A snapshot older than the split, naming a whole inventory file, still opens.
- `<snapshot>/try.json`: for Try it, each inventoried project's root (relative to the snapshot) and tsconfig, and each component specimen's recipe with its sibling looks (same file, role and wrapper chain, in line order, at most six). Beside `public/`, never in it, so it is neither served nor copied into a build; the dev and preview servers' `/__youi/try?project=<id>&specimen=<id>` reads it and accepts ids only (anything else is a 404).
- `<snapshot>/public/data/specimens.<project>.<light|dark>.<hash>.css`: each inventoried project's real CSS for its specimens, with forced-state twins for the state strips, and in its chunks static HTML per look. Built here, never by `youi inventory`, by `packages/scanner/src/specimens`: the stylesheets its pages load, in page order (sheets its server or source code reads and inlines first, ahead of the Tailwind output: string paths in `readFileSync`/`readFile`/`fs.promises` calls, `new URL('./x.css', import.meta.url)`, `?raw`/`?inline` CSS imports; then `<link rel="stylesheet">`s in `index.html`, other HTML and server templates, a link to a Tailwind CLI output mapped to the entry its `package.json` script builds; then what its layouts and components import; then any Tailwind entry nothing links, imports or reads, only when the page loads no other Tailwind entry (else it is skipped, and the output says so); or exactly the list in its `youi.project.json` `specimens.css`, or in the `specimens.css` of a `--config` kept outside the product, for the product its `root` or `--root` names, so the product is never edited), each Tailwind v4 entry compiled with the project's own installed `@tailwindcss/node` and oxide scanner in a worker with a time limit, `/fonts/…` files inlined as data URIs, `prefers-color-scheme` fixed per scheme; component looks server-rendered with esbuild and the project's own React from its node_modules (so CVA classes and Radix `data-state` come out as the app makes them), anything else, or a component that does not bundle, throws or overruns its time limit, as its tag and classes; an icon-size component (`size="icon"`, `icon-sm`, …) with no text of its own gets an icon, not a placeholder word. The snapshot's notes say which sheets were used and how, and its output lists each project's stylesheets in page order, then any Tailwind entry it skipped. Nothing outside the project root is read or run: a `../` or absolute `@import`, a symlink, font path, recipe file or tsconfig `paths` entry that leads out of it, and a package not in the root's own `node_modules`, are refused with a note. Nothing is written into the project: entries are cached by commit and content under `$XDG_CACHE_HOME/youiyoux/specimens` (`~/.cache/…`; `YOUI_SPECIMEN_CACHE` overrides), and a hit runs neither Tailwind nor esbuild. A project not on this machine, or with no stylesheet a page loads, gets none: its tiles draw the look's measured shape.
- `<snapshot>/public/data/detect.<hash>.json` and `detect.shot.<hash>.png`: a `youi detect` report (`--detect`, validated against `youi.detect/v1`) and its element screenshots, renamed by content and named in the manifest's `detect` entry. Like project screens it belongs to whoever ran it: the committed demo snapshot never holds one (`--detect` needs `--out`).
- `<snapshot>/preview/`: `system.css` (the system's variables scoped to `.system-scope`, the surface it sits on, and its Tailwind theme) and the system's owned component files, which the preview frame renders.
- `src/styles/generated/`: the hub's own tokens (`design/youiyoux.*.json`, DTCG, built by `@youiyoux/tokens` like any system's) as CSS variables and a Tailwind v4 theme. The hub replaces Tailwind's colour, radius, shadow, type and easing scales with its tokens (the reserved names are mapped explicitly in `scripts/snapshot.ts`), so it uses no style that is not a YouIyouX token. Rebuilt with the default snapshot.

## Previews

The element Overview shows a captured image (`<snapshot>/public/previews/<component>.<scheme>.webp`) until someone clicks; then it loads `preview.html`, which renders the system's own demo for that component with the system's tokens, in its own document. Demos live in the design repo, beside each contract: `components/<name>/<name>.demo.tsx`, a default-exported React component that imports the owned files by their vendored names (`./button`, `./utils`). A component with no demo says so in the frame. The style editor uses the same frame with `?screen=components|type|scale|motion|focus` and posts it the unsaved edits as CSS-variable overrides (`yx-preview-vars`, per scheme) and a pinned state (`yx-preview-state`: the frame copies its `:hover`, `:active`, `:focus-visible` and `:disabled` rules under `[data-pin-state]`); see `src/preview/protocol.ts`. The frame's `system.css` writes aliases as `var()` references, so an override of one token reaches every token that reads it. The frame gets its own Tailwind sheet, so a system's vocabulary (shadcn's `bg-primary`, or the demo's `bg-accent`) never collides with the hub's.

`scripts/capture.sh [base-url] [previews|screens|all]` refreshes the thumbnails (into the running snapshot) and the review screenshots in `screenshots/` (light and dark) with `chrome-devtools-axi`. The committed screenshots show the demo system.

The Inventory page is captured with Playwright instead: `playwright-core` (a pinned dev dependency) driving its headless-shell Chromium, never `chrome-devtools-axi`.

```sh
pnpm exec playwright-core install chromium-headless-shell   # once; the browser is not committed
pnpm dev                                                    # in another terminal
node scripts/capture-inventory.ts [--base http://localhost:5173] [--out screenshots]
node scripts/capture-inventory.ts --serve [--out screenshots]   # or: snapshot the fixtures, build and serve it itself
```

Once every specimen frame on screen has drawn, it writes at 1440×900 `inventory.{light,dark}.png` (filters, headline, top of the wall), `inventory-filtered` (`?type=button&project=console`), `inventory-compare` (a compare card, its slider dragged, then moved by a key so its focus ring shows), `inventory-compare-states` (that card's States), `inventory-fixes`, `inventory-drawer` (a family opened), `inventory-states` (its Variants as States: each look's strip), `inventory-try-tabs` (the console's Tabs after Try it, its second trigger clicked in the live frame) and `inventory-lead` (`?project=mobile`), and at 390×844 (mobile, touch) `phone-inventory` (the two-column wall), `phone-inventory-filters` (the filters' sheet), `phone-inventory-compare`, `phone-inventory-compare-states`, `phone-inventory-fixes`, `phone-inventory-sheet` (a family's bottom sheet), `phone-inventory-states`, `phone-inventory-try-tabs` and `phone-inventory-lead`, each `.{light,dark}.png`. With `--serve`, Try it is answered by `vite preview` from the fixtures' snapshot. It also checks, into `inventory-checks.json`, that on a phone every control on the page and in both sheets is at least 44px tall, and that at both widths no lead tile (wall, compare, fix) is blank; it exits 1 when one fails. `--serve` adds the `widgets` fixture, shaped like the Toolroll console (its Tailwind entry built by the CLI and linked from `index.html` and a server template), the `sketch` fixture, which loads no stylesheet, so one tile shows the shape-only fallback, and the `mobile` fixture, whose back button is used most in a look that is `display: none` at the 1280px desk width, so its lead tile draws the desktop look instead of a blank.

## Project screens

The Screens pictures belong to the product, like its usage map: they live in `<product>/.youi/screens/` (or any directory passed as `--screens`), never in this repo. `screens.json` there names each route and the address that shows it:

```json
{ "schema": "youiyoux.screens/v1", "project": "acme-app", "source": "acme-app demo, seeded data", "capturedAt": "2026-10-11",
  "viewport": { "width": 1440, "height": 900 }, "screens": [{ "route": "/settings", "path": "/settings" }] }
```

Capture from a running copy with seeded or demo data, never someone's working instance; sign in first in the same `chrome-devtools-axi` session:

```sh
node scripts/capture-screens.ts --dir ~/src/acme-app/.youi/screens --base http://127.0.0.1:3000
youi ui --project ~/src/acme-app        # or: pnpm data --project ~/src/acme-app --out .hub
```

Issues reach a screen through the scanner's file-to-route map, even when a file renders no system element. A violation, lookalike or unresolved site counts on every route that reaches its file through scanned imports. Files with no known route appear under **Not on any screen**, with a reason. Older snapshots need a new scan to place their issues.

| Project routes config | How files reach screens |
| --- | --- |
| `expo-router` | Route files under `appDir`, their layouts and imported files |
| `map` | Files matched by each map entry and their imported files |
| `shell` | Matching files and their imports belong to the app shell (`*`) |
| `none` | No routes inferred; explicit shell entries still apply |
| Import edges | Static imports, re-exports, literal `import()` (including `lazy`), `require()` and CSS `@import` are followed |
| Route boundaries | Walks stop at other screen or shell files, except when forwarding a default component |
| Finding routes | Violations, lookalikes and unresolved sites look up their file in `fileRoutes`; they do not repeat route lists |

The usage map saves `fileRoutes` for every scanned file. Imports stay within the scan's include/exclude set; type-only imports are left out. Unrouted reasons explain what imports the file and how to place it; global stylesheets can go in `routes.shell`. Focused scans explain that routes were not checked.

## Preview deploys

Every pull request can get its own link to the hub built from that branch, so a change is tested in the browser before it merges. The preview is public (unlisted, `noindex`), so it only ever shows the committed demo snapshot.

```sh
pnpm build:preview   # tsc + vite build on snapshot/, then check dist/
pnpm serve:preview   # serve dist/ on $PORT (default 8080), health at /healthz
```

- `scripts/build-preview.ts` ignores `YOUI_HUB_SNAPSHOT` and fails unless every file under `dist/data` and `dist/previews` is byte-identical to `snapshot/public` and the manifest lists only the `demo` system. A real system's snapshot cannot reach a preview by accident.
- `scripts/serve-preview.ts` is a dependency-free Node server: client routes fall back to `index.html`, hashed assets and data are cached for good, everything else revalidates, and it never serves outside `dist/`.
- `.railway/railway.ts` (Railway Infrastructure as Code) declares one service, `youiyoux-web`, built by Railway's default builder from the repository root with `pnpm --filter @youiyoux/web build:preview` and started with `node apps/web/scripts/serve-preview.ts`.
- `.github/workflows/web-preview.yml` runs the same preview build on every PR, with no secrets. Railway's own bot comments each PR's preview link when its environment is ready.

### Turning it on

None of this touches an outside account until someone with access to the Railway workspace and the `ap9000/youiyoux` repository does these steps:

1. In Railway, create a project (or pick one) and install the Railway GitHub App on `ap9000/youiyoux`. The repository is private, so a project member needs a connected GitHub account with access to it.
2. From the repository root: `railway login`, `railway link` (that project, `production` environment), `railway config plan` to review, then `railway config apply`. This creates the `youiyoux-web` service from `main`.
3. Give that service a Railway-provided domain (Service → Settings → Networking → Generate Domain). PR environments only get domains when the base service has one.
4. Project Settings → Environments → **Enable PR Environments**. Leave Bot PR Environments off unless agent-opened PRs should get previews; PRs opened from accounts outside the workspace are never deployed.
5. Open a PR. Within a few minutes Railway's bot comments with the preview link.

No secrets are needed: the build reads only the repository. Closing or merging a PR deletes its environment.

## Speed

Budgets: search under 50 ms, navigation under 100 ms, initial download (first route, fonts included) under 150 KB. `pnpm build && pnpm measure` writes `perf/report.json` and fails over the budgets in `perf/budget.json`; `pnpm measure:inventory` builds and serves 50- and 5,000-look inventories and fails when the Inventory page's first paint grows with the library (`perf/inventory.json`); [PERFORMANCE.md](PERFORMANCE.md) has the latest numbers and how they were taken. Home shows live search and navigation timings for the current tab.

## Code

```
design/            YouIyouX DTCG tokens (light base, dark overrides, resolver)
scripts/           snapshot.ts (data), measure.ts (budgets), measure-inventory.ts (Inventory first paint), capture.sh (hub images), capture-screens.ts (project screens),
                   capture-inventory.ts (Inventory page, Playwright),
                   build-preview.ts + serve-preview.ts + preview/ (preview deploys)
src/app/           shell, routes (preloadable chunks), theme
src/data/          snapshot types (@youiyoux/core types, type-only), loading and cache, model, usage, inventory, contrast
src/search/        MiniSearch engine, Web Worker, client hook
src/shell/         nav rail, keyboard layer, command palette, shortcuts sheet
src/ui/            the hub's owned components
src/screens/       home, catalog, element tabs, tokens, rules, screens, library, inventory, stack (detect reports), style (style editor), changes (draft review), planned screens
src/preview/       the isolated preview frame (loads the snapshot's demos through the @snapshot alias)
snapshot/          the committed demo snapshot (data, previews, preview sources)
test/              unit tests (pnpm test)
```

Contract, rule and usage types are imported type-only from `@youiyoux/core`, so zod and the loaders never reach the browser bundle. `src/data/ids.ts` keeps its own few-line id parser for the same reason (core's `ids.ts` imports zod at module load). Stack drafts Library items with `@youiyoux/core/detect-draft`, which imports types only, for the same reason.
