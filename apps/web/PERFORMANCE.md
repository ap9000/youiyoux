# Performance

Budgets agreed for the hub: **search under 50 ms**, **navigation under 100 ms**, **initial download under 150 KB gzipped**. All three hold with wide margins. The download and engine numbers below are from the committed demo snapshot (28 elements); the in-browser search and navigation numbers were taken on a real 89-element system, so they are the harder case.

Measured 2026-10-11 on the production build (`pnpm build`, served by `vite preview`). Machine: Apple silicon laptop, Chrome via `chrome-devtools-axi`, no throttling.

## Initial download (`pnpm measure`, gzip -9)

| What | KB gz |
| --- | --- |
| JS loaded by `index.html` (entry, React, router, shell) | 82.4 |
| CSS (`main.css`, all hub styles) | 8.3 |
| **JS + CSS** | **90.7** |
| Snapshot the first screen fetches (manifest + demo catalog) | 6.5 |
| **Total before first data render** | **97.2** of 150 |

The catalog grows with the system: the 89-element system's was 23 KB, for a total of 113 KB.

Not in the initial download:

- Route chunks are preloaded on hover, focus and idle. The largest are catalog 14.6 KB, palette 7 KB, tokens 2.3 KB and home 2.2 KB.
- The search worker and its engine: 5.8 KB.
- The usage map loads on idle: 1.4 KB for the demo app, 17 KB for a 265-site product.
- The preview frame, 1.2 KB JS plus the system's demos and 3.8 KB CSS, loads on the first click.
- Fonts: Geist and Geist Mono, latin subsets, 29 + 23 KB woff2, `font-display: swap`.

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
- Long lists are virtualized: element list, token list and usage sites.

## Live numbers

Home → Speed shows search and navigation medians and p95 for the current tab against the budgets. `window.__youiyoux.samples()` in devtools returns the raw samples.

## Re-measuring

```sh
pnpm build && pnpm measure          # download sizes and engine latency → perf/report.json
pnpm preview                        # then use the app, and read Home → Speed
```
