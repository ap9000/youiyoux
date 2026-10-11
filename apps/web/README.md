# YouIyouX web

The design language hub: find an element, see its contract, tokens and rules, preview the real component, and see exactly where it lives in each project. Local-only for now: no server, no accounts.

```sh
pnpm install        # at the repository root (apps/* is in the workspace)
cd apps/web
pnpm dev            # http://localhost:5173
```

Everything the app reads is a committed static snapshot, so `pnpm dev` works on its own.

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

`pnpm data [--from <design-language checkout>] [--commit <sha>]` rebuilds everything the app reads, using the `@youiyoux/core` and `@youiyoux/tokens` code from that checkout (default: this repository's root). The snapshot records the commit that last changed the definitions it read.

- `public/data/manifest.json` plus content-hashed `signal.catalog.<hash>.json` (tokens resolved per scheme, component contracts and their owned files, rules, the design narrative) and `<project>.usage.<hash>.json` (every `fixtures/*.usage.json`, validated against `youi.usage/v1`). The browser keeps hashed files in Cache Storage, so repeat visits and offline work need only the manifest.
- `src/styles/generated/`: the hub's own tokens (`design/youiyoux.*.json`, DTCG, built by `@youiyoux/tokens` exactly like Signal) as CSS variables and a Tailwind v4 theme. The hub replaces Tailwind's colour, radius, shadow, type and easing scales with its tokens (the reserved names are mapped explicitly in `scripts/snapshot.ts`), so it uses no style that is not a YouIyouX token.
- `src/preview/generated/`: Signal's variables scoped to `.signal-scope`, and Signal's owned component files, which the preview frame renders.

`fixtures/toolroll.usage.json` is the real `youi scan` of Toolroll, written outside the Toolroll repo:

```sh
node packages/cli/bin/youi.js scan --project <toolroll> --config pilot/toolroll/youi.project.json --design . --out apps/web/fixtures/toolroll.usage.json
```

## Previews

The element Preview tab shows a captured image (`public/previews/<component>.<scheme>.webp`) until someone clicks; then it loads `preview.html`, which renders the real owned component with Signal's tokens in its own document. Signal's components speak shadcn's vocabulary (`bg-primary`, `bg-accent`), so they get their own Tailwind sheet there and never collide with the hub's. Demos live in `src/preview/demos.tsx`.

`scripts/capture.sh [base-url] [previews|screens|all]` refreshes the thumbnails and the review screenshots in `screenshots/` (light and dark) with `chrome-devtools-axi`.

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
src/preview/       the isolated preview frame
test/              unit tests (pnpm test)
```

Contract, rule and usage types are imported type-only from `@youiyoux/core`, so zod and the loaders never reach the browser bundle. `src/data/ids.ts` keeps its own few-line id parser for the same reason (core's `ids.ts` imports zod at module load).
