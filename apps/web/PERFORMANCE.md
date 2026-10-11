# Performance

Budgets agreed for the hub: **search under 50 ms**, **navigation under 100 ms**, **initial download under 150 KB gzipped**. All three hold on the Signal dataset with wide margins.

Measured 2026-10-11 on the production build (`pnpm build`, served by `vite preview`), Signal at design-language `9dc4a9d`, Toolroll scan at `f2eb568`. Machine: Apple silicon laptop, Chrome via `chrome-devtools-axi`, no throttling.

## Initial download (`pnpm measure`, gzip -9)

| What | KB gz |
| --- | --- |
| JS loaded by `index.html` (entry, React, router, shell) | 81.8 |
| CSS (`main.css`, all hub styles) | 8.3 |
| **JS + CSS** | **90.1** |
| Snapshot the first screen fetches (manifest + Signal catalog) | 23.0 |
| **Total before first data render** | **113.2** of 150 |

Not in the initial download:

- Route chunks are preloaded on hover, focus and idle. The largest are catalog 10 KB, palette 7 KB, home 2.3 KB and tokens 2.3 KB.
- The search worker and its engine: 5.8 KB.
- The usage map, 17 KB, loads on idle.
- The preview frame, 13.6 KB JS + 5.1 KB CSS, loads on the first click.
- Fonts: Geist and Geist Mono, latin subsets, 29 + 23 KB woff2, `font-display: swap`.

Repeat visits transfer about 8 KB, because hashed snapshot files come from Cache Storage and assets from the HTTP cache. First contentful paint was 44 ms locally.

Full per-file numbers are in [`perf/report.json`](perf/report.json).

## Search

The engine is MiniSearch: prefix, fuzzy for terms of 4+ characters, and AND across terms. It is the same engine the Web Worker runs.

| Dataset | Docs | p50 | p95 | Max |
| --- | --- | --- | --- | --- |
| Signal, `pnpm measure` (engine only, 12 queries × 200 runs) | 89 | 0.012 ms | 0.038 ms | 0.15 ms |
| 50× synthetic catalog, same queries | 4,450 | 0.18 ms | 0.43 ms | (index build 44 ms, once, in the worker) |
| In the browser, query to answer (worker round trip + main thread), 41 queries typed back to back | 89 | 7.9 ms | 19.7 ms | 23 ms |

The in-browser figure is dominated by waiting for the main thread to finish rendering the previous keystroke's results, not by search. It is what a person feels, and it stays under half the budget.

## Navigation

Measured in the app from input (click, `j`/`k`, `g` chord, tab change) to the next frame after the new route commits (`src/lib/perf.ts`). The numbers come from 54 navigations across list moves, element tabs and every screen:

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
