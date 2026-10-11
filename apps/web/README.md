# YouIyouX web

The design language hub: find an element, see its contract, tokens and rules, preview the real component, and see exactly where it lives in each project. Local-only for now: no server, no accounts.

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

## Screens

| Route | What it is |
| --- | --- |
| `/` | Home: the system, where it lives, rule health, live speed numbers |
| `/elements[/<system>/<kind>/<name>[/<tab>]]` | Catalog (search, kind filter) beside the element page: Preview, Contract, Tokens, Rules, Where it lives. Tokens and rules open their own detail. |
| `/tokens[/<path>]` | Token explorer: palette overview, light and dark values, alias chain, WCAG contrast, consumers |
| `/screens` | Each project screen and the elements it renders (from the usage map) |
| `/changes`, `/access` | Planned: change requests (plan, rollout, visual review) and access |

Keyboard: `⌘K` palette, `/` search the list, `j`/`k` or arrows move, `g` then `h e t s c a` to jump, `?` for all shortcuts.

## Data

`pnpm data [--design <dir>] [--project <dir>] [--config <file>] [--out <dir>] [--commit <sha>]` (`scripts/snapshot.ts`) builds a snapshot with this repository's `@youiyoux/core`, `@youiyoux/tokens` and `@youiyoux/scanner`; it never runs code from the design repo. With no options it rebuilds the committed demo: `examples/demo-design`, and a scan of `examples/demo-app`.

- `--design` is the design repo checkout (the directory holding `youi.config.json`). `--project` scans a product repo, read-only, for the usage map; its `youi.project.json` (or `--config`) also names the design repo, the system, the CSS variable prefix and the Tailwind names its components use. The snapshot records the commit that last changed the definitions it read.
- `<snapshot>/public/data/`: `manifest.json` plus content-hashed `<system>.catalog.<hash>.json` (tokens resolved per scheme, component contracts and their owned files, rules, the design narrative) and `<project>.usage.<hash>.json` (validated against `youi.usage/v1`). The browser keeps hashed files in Cache Storage, so repeat visits and offline work need only the manifest. Vite serves them beside `public/` and copies them into the build.
- `<snapshot>/preview/`: `system.css` (the system's variables scoped to `.system-scope`, the surface it sits on, and its Tailwind theme) and the system's owned component files, which the preview frame renders.
- `src/styles/generated/`: the hub's own tokens (`design/youiyoux.*.json`, DTCG, built by `@youiyoux/tokens` like any system's) as CSS variables and a Tailwind v4 theme. The hub replaces Tailwind's colour, radius, shadow, type and easing scales with its tokens (the reserved names are mapped explicitly in `scripts/snapshot.ts`), so it uses no style that is not a YouIyouX token. Rebuilt with the default snapshot.

## Previews

The element Preview tab shows a captured image (`<snapshot>/public/previews/<component>.<scheme>.webp`) until someone clicks; then it loads `preview.html`, which renders the system's own demo for that component with the system's tokens, in its own document. Demos live in the design repo, beside each contract: `components/<name>/<name>.demo.tsx`, a default-exported React component that imports the owned files by their vendored names (`./button`, `./utils`). A component with no demo says so in the frame. The frame gets its own Tailwind sheet, so a system's vocabulary (shadcn's `bg-primary`, or the demo's `bg-accent`) never collides with the hub's.

`scripts/capture.sh [base-url] [previews|screens|all]` refreshes the thumbnails (into the running snapshot) and the review screenshots in `screenshots/` (light and dark) with `chrome-devtools-axi`. The committed screenshots show the demo system.

## Speed

Budgets: search under 50 ms, navigation under 100 ms, initial download under 150 KB gzipped. `pnpm build && pnpm measure` writes `perf/report.json`; [PERFORMANCE.md](PERFORMANCE.md) has the latest numbers and how they were taken. Home shows live search and navigation timings for the current tab.

## Code

```
design/            YouIyouX DTCG tokens (light base, dark overrides, resolver)
scripts/           snapshot.ts (data), measure.ts (budgets), capture.sh (images)
src/app/           shell, routes (preloadable chunks), theme
src/data/          snapshot types (@youiyoux/core types, type-only), loading and cache, model, usage, contrast
src/search/        MiniSearch engine, Web Worker, client hook
src/shell/         nav rail, keyboard layer, command palette, shortcuts sheet
src/ui/            the hub's owned components
src/screens/       home, catalog, element tabs, tokens, planned screens
src/preview/       the isolated preview frame (loads the snapshot's demos through the @snapshot alias)
snapshot/          the committed demo snapshot (data, previews, preview sources)
test/              unit tests (pnpm test)
```

Contract, rule and usage types are imported type-only from `@youiyoux/core`, so zod and the loaders never reach the browser bundle. `src/data/ids.ts` keeps its own few-line id parser for the same reason (core's `ids.ts` imports zod at module load).
