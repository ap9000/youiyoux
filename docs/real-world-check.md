# Real-world check: Signal and Toolroll

PR #8 integrated System/Library, change safety, live checks, Screens, the rule editor and previews, but only the demo tests ran. This is every integrated feature run against real data, the defects it found, and what changed. A review of the first run found four more defects (marked *review*); each is fixed with a test, and the affected steps ran again on a fresh copy.

| | |
| --- | --- |
| Design repo | Signal, `~/Developer/toolroll-design` @ `86ab35b`, config `pilot/toolroll/youi.project.json`; read only |
| Product | Toolroll, `~/Developer/standing-orders` @ `55caab73`, exported with `git archive HEAD` into `.scratch/toolroll` (gitignored), then `git init` and one commit there for the git steps (made fresh again for the rerun) |
| Writes | only to `.scratch/`: the baseline, editor drafts, a local clone of the design repo for the review branch, the hooks and the CI workflow |
| Runtime | Node 24.21.0, pnpm 10.13.1; Playwright 1.63 with Chromium for the hub |
| Afterwards | `git status` in both real repos is unchanged |

`P` is `~/Developer/toolroll-design/pilot/toolroll`, `C` is `$P/youi.project.json`, `T` is `.scratch/toolroll`.

## Steps

| # | Step | Command | Result | What was wrong | What changed | Test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Check from the pilot config | `youiyoux check --project $P` | pass, after a fix | Scanned 0 files and said `tsconfig.browser.json could not be fully analysed`: the config's directory was taken as the product root, so a config kept beside the design repo could not reach its product, and 0 files looked like a near-pass | New product root: `root` in `youi.project.json` (relative to the config) or `--root <dir>`, on every product command, hooks, the hub, the rule editor and MCP. A missing root, or one where nothing matches `include`, now stops with the root, the config and how to set `root` | `packages/scanner/test/project.test.ts`, `packages/cli/test/cli.test.ts` (config outside the product) |
| 2 | init | `youiyoux init --dry-run --design ~/Developer/toolroll-design --project .scratch/toolroll-init` | pass, after a fix | Wrote `cssVarPrefix: "youi"`, so a real sync would have renamed all 162 `--so-*` variables Toolroll already ships in its youi-generated `src/design/tokens.css` | init reads the prefix of a tokens.css youi generated before and keeps it (`so`), and says so. *Review:* the prefix was the variables' common prefix, so a system whose tokens all sit in one group (`--acme-color-bg`, `--acme-color-fg`) gave `acme-color`, and sync would have renamed every variable. Now each variable less the system's own token name (`color-bg`) gives the prefix, the one most variables agree on wins, and no match gives none. Rerun: still `so` | `cli.test.ts` (init keeps the prefix; the generated prefix is the variable name less the system's own token name) |
| 3 | sync --dry-run | `youiyoux sync --dry-run --project $P --root $T` | pass | Nothing. 4 updated, 5 created, 6 adopted, 1 conflict (exit 1): Toolroll's `ui/utils.ts` really differs from Signal's (it registers Signal's theme names with tailwind-merge). Token files differ only in the header line. Nothing written | none | n/a |
| 4 | scan | `youiyoux scan --config $C --root $T` | pass | Nothing. 42 files, complete, 404 ms in process (0.7 s wall); 265 sites, 5 unknown, 57 lookalikes | none | n/a |
| 5 | check | `youiyoux check --config $C --root $T` | pass, after a fix | 97 errors, 46 warnings in 19 files. Every canonical-import fix said `import { Button } from "src/browser/components/ui"`, which does not resolve in Toolroll (no `importFrom` alias) | Without `importFrom`, the fix is a path relative to the file (`./components/ui`, `../components/ui`); `youiyoux show` and the agent docs say the path is relative instead of printing one that does not resolve | `scanner.test.ts` (lookalike fix) |
| 6 | baseline | `youiyoux baseline --config $C --root $T --baseline-file .scratch/toolroll.baseline.json` | pass | Nothing. 97 errors and 46 warnings accepted. Without `--baseline-file` the baseline goes beside the config, which is in the design repo, so it was kept in `.scratch/` | Baseline path now follows the config that was loaded, also when `--project` named the config's directory | covered by step 1 tests |
| 7 | check --baseline | `youiyoux check --baseline --config $C --root $T --baseline-file …` | pass | Nothing. 143 known, 0 new, exit 0; with one raw colour added: 1 new, exit 1 | none | n/a |
| 8 | where | `youiyoux where button --config $C --root $T` | pass | Nothing. 128 sites in 9 files on 7 screens plus the app shell, 39 lookalikes not counted; spot-checked lines (`flow-view.tsx:210`, `chat-cards.tsx:53`) are real Buttons | none | n/a |
| 9 | bom | `youiyoux bom <route> --config $C --root $T`, for all 7 routes the pilot declares | pass, after a fix | The text named no files, and a mistyped route (`/setings`) printed an empty screen with exit 0, a false zero | The bill lists the screen's files; a route no file reaches is an error that lists the known routes (also for `system_screen_bom`) | `cli.test.ts` (bom) |
| 10 | Hub on Signal | `youiyoux ui --config $C --root $T`, and `youiyoux ui --project $T --config $C --root $T --state .scratch/editor-state` for the rule editor | pass, after a fix | *Review:* `youiyoux ui --config $C --root $T` without `--project` ignored `--root` and showed no usage map (unless `--watch` was on). Rerun: both commands render Signal and Toolroll's usage (8 components, 75 tokens, 6 rules, 265 sites, 144 violations: 143 plus the step 13 probe) on home, the Button page and its Usage tab, and the rule page and editor, at 1440 px and 390 px, with no console errors. At 390 px the draft breadcrumb's "All changes" wraps to two lines (cosmetic, left) | `--root` reaches the snapshot and the rule editor. The snapshot scans the product whenever `--config` comes with `--root`, from the config's directory, with or without `--watch`; the web README shows the command | `cli.test.ts`, `apps/web/test/snapshot.test.ts` (`--config` with `--root` scans the product) |
| 11 | Rule edit in the browser | the same, on a local clone `.scratch/toolroll-design` | pass | Nothing. Rerun on a fresh clone: Edit rule opened draft `d-7fa916184d`; Statement edited and saved (revision 2); impact preview: 24 places in 9 files, 0 new, 24 already flagged, 0 no longer flagged; approved revision 2; review branch `youi/rules/components.no-native-controls-7fa916` holds only the one-line rule change. On a rule with an open draft the button reads Open draft, as intended | none | n/a |
| 12 | hooks install | `youiyoux hooks install --claude --git --project $T --config $C`; `youiyoux hooks install --ci` the same way, then the workflow's check command run from `$T` | pass, after a fix | Installed both. Installing with `--project $P --root $T` would have left the hook without the config's path, so it could not load the project. *Review:* for a product at its repo root (Toolroll is one) the CI command could get `--root ''`, which the loader read as unset, so a config that sets `root` won and every CI run failed with `product root … is not a directory` (reproduced on `$T` with a copy of the config that sets `root`) | The installed command carries the config file whenever it is not in the product, plus `--root`; the CI workflow passes `--root` with an outside config. The workflow never passes an empty `--project` or `--root` (`.` instead), and an empty `--root` now means the current directory. Rerun: the workflow says `--project . … --root .`; run from `$T` it scans 42 files, 143 known, 0 new, exit 0; `--root ''` with a config whose `root` points elsewhere scans `$T` | `hooks.test.ts` (config beside the design repo; product at its repo root gets `--root .`), `cli.test.ts` (an empty `--root` is the current directory) |
| 13 | Hooks run | `git commit` of a staged raw colour; `youiyoux hooks run claude` with an Edit payload | pass | Nothing. Rerun: both report the file's findings (including the new `#ff00aa`) as advisory and exit 0. With no baseline beside the read-only pilot config they list every finding in the file, not only the new one | none | n/a |
| 14 | MCP `system_get_rules` | `youiyoux mcp --project $T --config $C`: initialize, initialized, tools/list, tools/call | pass | Nothing. 10 tools; `system_get_rules` returns Signal's 6 rules in 2.4 KB. The same with `--project $P --root $T` | `--root` reaches the server | `mcp.test.ts` (productRoot) |

Totals: 14 steps, 14 pass; 9 defects fixed, each with a test: 5 from the first run, 4 from its review (steps 2, 10 and 12, and the evidence below).

## Evidence

Kept with this run's evidence (`evidence/`, gitignored), not in the repository. *Review:* the first run committed its transcripts (`evidence/transcripts/`), which hold Toolroll's paths and findings. They are removed from the repository, `evidence/` is ignored, and `packages/cli/test/repo.test.ts` fails if anything under it is tracked.

| File | What |
| --- | --- |
| `transcripts/00-init-dry-run.txt` … `10-mcp-system_get_rules.txt` | Output of steps 2 to 14 (`08b`, `08c`: the CI workflow and its command) |
| `hub-config-root/{desktop,phone}-{home,element-button,element-button-usage}.png` | `youiyoux ui --config $C --root $T` at 1440 × 900 and 390 × 844 |
| `hub/{desktop,phone}-{home,element-button,element-button-usage,rule,rule-editor}.png` | The hub with the rule editor, at the same sizes |
| `hub/flow-{1-saved,2-preview,3-approved,4-review}.png`, `hub/hub.log` | The rule-edit flow |

## Left for later

| What | Why not here |
| --- | --- |
| Signal's `schema/` copies are out of date (`youiyoux schema --check --design ~/Developer/toolroll-design` lists 5 files, including the new `root`) | toolroll-design is read only for this work; run `youiyoux schema --write --design .` there |
| The pilot config could set `"root"` and drop the `--root` flag; its README still says to clone Toolroll to `/tmp` | same |
| A scratch copy with no `.git` inside another repository reports that repository's commit as the product commit | only seen with `git archive` copies; `git init` in the copy fixes it |
| `hsl(${hsv.h} 100% 50%)` in a template string counts as a raw colour | a rule judgement for Signal's owners, not a run failure |
