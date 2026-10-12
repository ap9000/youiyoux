# YouIyouX web

The design language hub: find an element, see its contract, tokens and rules, preview the real component, and see exactly where it lives in each project. Local-only for now: no accounts. Everything reads a static snapshot except Rules and Changes, which talk to the local rule editor that `youi ui --project` starts.

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
```

The hub shows one design system at a time, read from a snapshot directory. The committed default (`snapshot/`) is the made-up demo system, so `pnpm dev` works on its own and the tool repo holds no product's data. `youi ui` with a system named writes its snapshot to `.hub/` (gitignored) and starts the dev server on that instead, so pointing the hub at a real system never changes the checkout.

Rules and Changes are live rather than a snapshot when the rule editor runs: `youi ui --project <dir>` starts it beside the dev server, which proxies `/api` to it.

## Screens

The nav rail has three labelled groups: **System** (Overview, Components, Tokens, Rules, Screens: approved elements, their rules and live usage; what products build with), **Library** (Browse, Sources: what is ingested from outside, to browse and propose; never built with) and **Work** (Changes). Access stays reachable at `/access`.

| Route | What it is |
| --- | --- |
| `/` | Home: the system, where it lives, rule health, live speed numbers |
| `/elements[/<system>/<kind>/<name>[/<tab>]]` | Catalog (search, kind filter) beside the element page: Overview (live preview, uses, screens, what to look at), Usage, Contract & tokens, Rules. Tokens and rules open their own detail. |
| `/tokens[/<path>]` | Token explorer: palette overview, light and dark values, alias chain, WCAG contrast, consumers |
| `/rules[/<name>]`, `/rules/draft/<id>` | Every rule: what it checks, its level, where it is broken (counts and places). Edit and New rule open a draft on the rule's page: form, impact preview, approval, review branch. Live from the rule editor (`youi ui --project`, [guide](../../packages/workflow/README.md)); read-only from the snapshot without it |
| `/screens[/<project>/<screen>]` | Each project screen as a screenshot with its element and issue counts; a screen opens with its full screenshot, the elements it renders and the rule issues in its files (`j`/`k` step between screens) |
| `/library`, `/library/sources` | The Library (Browse): ingested candidates. Empty for now: explains the sources to come, the `library → candidate → adopted → in-use` path and what agents may do. Sources is planned |
| `/changes` | Work: the review queue for every change: draft, waiting for approval, approved, sent for review, rolled out |
| `/access` | Planned: access |

Keyboard: `⌘K` palette, `/` search the list, `j`/`k` or arrows move, `g` then `o c t r s l i w` to jump, `?` for all shortcuts.

## Data

`pnpm data [--design <dir>] [--project <dir>] [--config <file>] [--out <dir>] [--commit <sha>]` (`scripts/snapshot.ts`) builds a snapshot with this repository's `@youiyoux/core`, `@youiyoux/tokens` and `@youiyoux/scanner`; it never runs code from the design repo. With no options it rebuilds the committed demo: `examples/demo-design`, and a scan of `examples/demo-app`.

- `--design` is the design repo checkout (the directory holding `youi.config.json`). `--project` scans a product repo, read-only, for the usage map; its `youi.project.json` (or `--config`) also names the design repo, the system, the CSS variable prefix and the Tailwind names its components use. The snapshot records the commit that last changed the definitions it read.
- `<snapshot>/public/data/`: `manifest.json` plus content-hashed `<system>.catalog.<hash>.json` (tokens resolved per scheme, component contracts and their owned files, rules, the design narrative) and `<project>.usage.<hash>.json` (validated against `youi.usage/v1`). The browser keeps hashed files in Cache Storage, so repeat visits and offline work need only the manifest. Vite serves them beside `public/` and copies them into the build.
- `<snapshot>/public/data/<project>.screen.<hash>.webp`: the project's screens, light and dark, when it has captured them (see [Project screens](#project-screens)). The manifest lists them per route; a route without a picture shows an empty state.
- `<snapshot>/preview/`: `system.css` (the system's variables scoped to `.system-scope`, the surface it sits on, and its Tailwind theme) and the system's owned component files, which the preview frame renders.
- `src/styles/generated/`: the hub's own tokens (`design/youiyoux.*.json`, DTCG, built by `@youiyoux/tokens` like any system's) as CSS variables and a Tailwind v4 theme. The hub replaces Tailwind's colour, radius, shadow, type and easing scales with its tokens (the reserved names are mapped explicitly in `scripts/snapshot.ts`), so it uses no style that is not a YouIyouX token. Rebuilt with the default snapshot.

## Previews

The element Overview shows a captured image (`<snapshot>/public/previews/<component>.<scheme>.webp`) until someone clicks; then it loads `preview.html`, which renders the system's own demo for that component with the system's tokens, in its own document. Demos live in the design repo, beside each contract: `components/<name>/<name>.demo.tsx`, a default-exported React component that imports the owned files by their vendored names (`./button`, `./utils`). A component with no demo says so in the frame. The frame gets its own Tailwind sheet, so a system's vocabulary (shadcn's `bg-primary`, or the demo's `bg-accent`) never collides with the hub's.

`scripts/capture.sh [base-url] [previews|screens|all]` refreshes the thumbnails (into the running snapshot) and the review screenshots in `screenshots/` (light and dark) with `chrome-devtools-axi`. The committed screenshots show the demo system.

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

The usage map saves `fileRoutes` for every scanned file and route details on each finding. Static imports (including stylesheets) and re-exports are followed within the scan's include/exclude set; type-only imports are left out. Focused scans explain that routes were not checked.

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

Budgets: search under 50 ms, navigation under 100 ms, initial download (first route, fonts included) under 150 KB. `pnpm build && pnpm measure` writes `perf/report.json` and fails over the budgets in `perf/budget.json`; [PERFORMANCE.md](PERFORMANCE.md) has the latest numbers and how they were taken. Home shows live search and navigation timings for the current tab.

## Code

```
design/            YouIyouX DTCG tokens (light base, dark overrides, resolver)
scripts/           snapshot.ts (data), measure.ts (budgets), capture.sh (hub images), capture-screens.ts (project screens),
                   build-preview.ts + serve-preview.ts + preview/ (preview deploys)
src/app/           shell, routes (preloadable chunks), theme
src/data/          snapshot types (@youiyoux/core types, type-only), loading and cache, model, usage, contrast
src/search/        MiniSearch engine, Web Worker, client hook
src/shell/         nav rail, keyboard layer, command palette, shortcuts sheet
src/ui/            the hub's owned components
src/screens/       home, catalog, element tabs, tokens, rules, screens, library, changes (rule editor), planned screens
src/preview/       the isolated preview frame (loads the snapshot's demos through the @snapshot alias)
snapshot/          the committed demo snapshot (data, previews, preview sources)
test/              unit tests (pnpm test)
```

Contract, rule and usage types are imported type-only from `@youiyoux/core`, so zod and the loaders never reach the browser bundle. `src/data/ids.ts` keeps its own few-line id parser for the same reason (core's `ids.ts` imports zod at module load).
