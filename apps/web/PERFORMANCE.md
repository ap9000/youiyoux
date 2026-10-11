# Performance

Budgets agreed for the hub: **search under 50 ms**, **navigation under 100 ms**, **initial download under 150 KB**, counting the fonts the first route renders with. All three hold. The download and engine numbers below are from the committed demo snapshot (28 elements); the in-browser search and navigation numbers were taken on a real 89-element system, so they are the harder case.

Measured 2026-10-11 on the production build (`pnpm build`, served by `vite preview`). Machine: Apple silicon laptop, Chrome via `chrome-devtools-axi`, no throttling.

## Initial download (`pnpm measure`)

The boundary is the first route: everything the browser fetches to render it. HTML, JS, CSS and JSON count gzipped (`-9`); woff2 counts as is, because it is already compressed.

| What | KB |
| --- | --- |
| `index.html` | 0.6 |
| JS loaded by `index.html` (entry, React, router, shell) | 82.4 |
| CSS (`main.css`, all hub styles) | 8.4 |
| Snapshot the first screen fetches (manifest + demo catalog) | 6.6 |
| Fonts: Geist and Geist Mono, cut to the hub's glyphs and weights (`font-display: swap`) | 29.2 |
| **Total for the first route** | **127.3** of 150 |

The catalog grows with the system: the 89-element system's was 23 KB, for a total of about 143 KB.

The fonts are subset by `scripts/subset-fonts.sh` from the fontsource Latin files: ASCII, Latin-1 and the punctuation and arrows the hub prints, on a weight axis cut to 400–600, the range the hub's tokens use. That takes them from 51.3 KB to 29.2 KB. They are declared after the full fontsource faces, so any other character still renders in Geist; its full face loads only when a page shows such a character. In the browser, the first route downloads exactly these two files.

`pnpm measure` exits 1, and so fails CI, when the first route is over the 150 KB in [`perf/budget.json`](perf/budget.json) or search p95 exceeds 50 ms. Where several faces of a font cover Latin text, it counts the one the browser uses (the last declared). These are build-artifact sizes, not a browser-measured cold transfer.

Not in the initial download:

- Route chunks are preloaded on hover, focus and idle. The largest are catalog 14.6 KB, palette 7 KB, tokens 2.3 KB and home 2.2 KB.
- Project screenshots load as they scroll into view: a thumbnail is about 13 to 21 KB, and a screen page loads one 2x image of about 83 to 136 KB (measured on Toolroll).
- The search worker and its engine: 5.8 KB.
- The usage map loads on idle: 1.4 KB for the demo app, 17 KB for a 265-site product.
- The preview frame, 1.2 KB JS plus the system's demos and 3.8 KB CSS, loads on the first click.

Repeat visits transfer about 8 KB, because hashed snapshot files come from Cache Storage and assets from the HTTP cache. First contentful paint was 44 ms locally.

Full per-file numbers are in [`perf/report.json`](perf/report.json).

## Search

The engine is MiniSearch: prefix, fuzzy for terms of 4+ characters, and AND across terms. It is the same engine the Web Worker runs.

| Dataset | Docs | p50 | p95 | Max |
| --- | --- | --- | --- | --- |
| Demo, `pnpm measure` (engine only, 12 queries × 200 runs) | 28 | 0.015 ms | 0.024 ms | 0.36 ms |
| 50× synthetic catalog, same queries | 1,400 | 0.12 ms | 0.26 ms | (index build 22 ms, once, in the worker) |
| In the browser, query to answer (worker round trip + main thread), 41 queries typed back to back, 89-element system | 89 | 7.9 ms | 19.7 ms | 23 ms |

The in-browser figure is dominated by waiting for the main thread to finish rendering the previous keystroke's results, not by search. It is what a person feels, and it stays under half the budget.

## Navigation

Measured in the app from input (click, `j`/`k`, `g` chord, tab change) to the next frame after the new route commits (`src/lib/perf.ts`). The numbers come from 54 navigations across list moves, element tabs and every screen of the 89-element system:

| p50 | p95 | Max |
| --- | --- | --- |
| 5.6 ms | 9.6 ms | 11.1 ms |

What keeps it there:

- Every route is its own chunk, preloaded on hover, focus and idle.
- Preloaded screens render synchronously. `React.lazy` would suspend once even after the chunk loaded, and React holds a suspended fallback for at least 300 ms. That cost was measured at 310 ms before the change.
- The catalog stays in memory.
- Long lists are virtualized: element list and token list. Usage sites are collapsed per screen and render 50 at a time until someone asks for the rest.

## Live numbers

Home → Speed shows search and navigation medians and p95 for the current tab against the budgets. `window.__youiyoux.samples()` in devtools returns the raw samples.

## Re-measuring

```sh
pnpm build && pnpm measure          # download sizes and engine latency → perf/report.json
pnpm preview                        # then use the app, and read Home → Speed
```
