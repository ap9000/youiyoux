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

## Inventory: first paint does not grow with the library (`pnpm measure:inventory`)

The Inventory page paints from a small index (projects, roles by project, counts): the filters and the headline. Each role's looks, families and specimens are a chunk per project, fetched only for the roles and projects the filters show: a role's when its row comes within 800 px of the scroll area, the rest one at a time when the browser is idle (the headline's estimate, the compare cards and the fix list need every family in view); kits, primitives and flags load right after the first paint. A specimen frame mounts within 600 px of the scroll area and unmounts beyond 1,800 px; at most six frames load at once; a family with more than 100 tiles is virtualised by rows.

`scripts/measure-inventory.ts` makes synthetic inventories of the scanner's fixtures at 50 and 5,000 looks (each copy a little taller and with its own label, so families and specimens multiply), snapshots each with specimens, builds the hub against it, serves it with `vite preview` and opens `/inventory` cold in headless Chromium five times. It counts the bytes transferred (headers included, uncompressed preview server) until the frame after the headline (filters, family count, drawn from the index alone) is in the DOM, and reads FCP.

Measured 2026-10-12 (with state strips and Try it), Apple silicon laptop, median of 5:

| Looks | Families | Index | Requests before the inventory paints | Bytes before it paints | Inventory paint | FCP |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 16 | 3.3 KB | 28 | 186,050 | 171 ms | 184 ms |
| 5,000 | 126 | 3.4 KB | 28 | 186,103 | 175 ms | 188 ms |

It exits 1 when the larger run transfers more than the smaller's bytes + 10%, or its median paint or FCP is over 1.5× the smaller's plus one frame (16 ms). It also exits 1 when, a second after the paint with nothing clicked, the page has asked for any of Try it (the `try-live` chunk or a `/__youi/try` bundle) or mounted a state strip, or when the build carries `try.json`: in both runs above, none. State strips and Try it added 2.8 KB before the paint at both sizes (183,283 → 186,050 bytes at 50 looks): the Try it button, the one-live-tile store and the strip component in the Inventory chunk. The live frame is its own chunk, fetched on the first Try it; a look's bundle (the console's Tabs with React and Radix: about 250 KB, built in about 150 ms) is fetched only for the tile clicked, and cached by its content hash. The forced-state twins add about 3% to a project's specimen stylesheet (33.2 KB → 34.2 KB for the console), once per sheet, whatever the number of looks. Only counts grow in the index. What does grow is after the paint: at 5,000 looks the console's button chunk is 1 MB uncompressed (its 2,000-odd looks and their specimen HTML), loaded when the Buttons row nears the screen or the browser is next idle, unless a filter leaves buttons or the console out. The specimen stylesheets do not grow with looks: 33 KB per scheme for the console (its Tailwind build, with its 13 KB font inlined), 1.5 KB for the site. Full numbers are in [`perf/inventory.json`](perf/inventory.json).

Re-measured 2026-10-12 with the local index in place (`/__youi/query` on the preview server): the page asks the index nothing before it paints, or after, with nothing clicked, and `measure:inventory` now fails if it ever does.

| Looks | Families | Index | Requests before the inventory paints | Bytes before it paints | Inventory paint | FCP | Index queries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 16 | 3.4 KB | 28 | 186,188 | 178 ms | 196 ms | 0 |
| 5,000 | 126 | 3.5 KB | 28 | 186,240 | 171 ms | 184 ms | 0 |

## The local index at 100,000 Library items

`packages/store/bench/library.ts` builds 100,000 synthetic Library listings shaped like Discover's (about 1 KB each, with provenance: 1% official, 70% community registries, 29% npm) and an inventory of 5,000 looks, loads them into each engine, and times 20 needs (command menu, toast, date picker, …), five runs each after a warm-up. A search is what `youi discover` and `discover_search` do: the full-text index narrows the catalog to at most 400 listings per source class, Discover's scorer ranks them, the first page is shaped for output. `YOUI_PERF=1 pnpm vitest run packages/store/test/store.perf.test.ts` runs it and fails when SQLite's p95 is 50 ms or more; `node packages/store/bench/library.ts` prints the same.

Measured 2026-10-12, Apple silicon laptop, Node 24.21:

| Engine | Load 100,000 items + 5,000 looks | Search p50 | Search p95 | Max | where_used | swap_impact |
| --- | --- | --- | --- | --- | --- | --- |
| SQLite (node:sqlite, FTS5) | 11.5 s | 27.5 ms | 40.0 ms | 44.6 ms | 24 ms | 23 ms |
| Postgres (PGlite, in-process) | 17.9 s | 109 ms | 146 ms | 174 ms | 70 ms | 69 ms |

What keeps SQLite there: the full-text table carries each listing's scope and source class as tag words, so a search ranks inside the index with one `ORDER BY bm25 LIMIT 400` per source class and reads only those listings; a phrase's generic words (`react` in react-day-picker) are not sent, since one specific word of each phrase already keeps every listing the scorer could match. PGlite is Postgres compiled to WebAssembly on one thread, used for tests; it is reported, not budgeted. A Postgres server is expected to be faster, and was not measured here.

## Live numbers

Home → Speed shows search and navigation medians and p95 for the current tab against the budgets. `window.__youiyoux.samples()` in devtools returns the raw samples.

## Re-measuring

```sh
pnpm build && pnpm measure          # download sizes and engine latency → perf/report.json
pnpm measure:inventory              # Inventory first paint at 50 vs 5,000 looks → perf/inventory.json
YOUI_PERF=1 pnpm vitest run packages/store/test/store.perf.test.ts   # (from the repo root) the local index at 100,000 items
pnpm preview                        # then use the app, and read Home → Speed
```
