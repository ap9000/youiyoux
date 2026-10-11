# Toolroll pilot

Toolroll's "Signal" design system is the first real system in YouIyouX. This directory is how the pilot was run and what it measured. The proposed Toolroll fixes are in [`../toolroll-findings.md`](../toolroll-findings.md).

Toolroll is never written to. Every run below uses a clone (`git clone` of the local checkout, origin removed). The project config lives here, in `youi.project.json`, so nothing has to be added to Toolroll to scan it.

## Files

| File | What it is |
| --- | --- |
| `youi.project.json` | Toolroll's project config: what to scan, where its owned components live, its token source, the route map (every entry cites its evidence), and how Signal maps onto its shadcn role names in Tailwind |
| `import-signal.ts` | The reproducible import: Toolroll's `DESIGN.md` plus `src/server/console.css` become `tokens/signal/*` and `systems/signal/design.md` |
| `import-report.json` | What the import found: 0 value mismatches, 2 names only in DESIGN.md, 24 shipped variables not in DESIGN.md |
| `verify-where.ts` | An independent check of `youi where button` that uses regular expressions, not the scanner |
| `proposals/button-vocabulary.migration.yaml` | A Button change proposal, run only as a dry run |

## Reproduce

```sh
git clone /path/to/toolroll /tmp/toolroll-copy && git -C /tmp/toolroll-copy remote remove origin
alias youi='node packages/cli/bin/youi.js --project /tmp/toolroll-copy --config pilot/toolroll/youi.project.json'

node pilot/toolroll/import-signal.ts /path/to/toolroll   # tokens/signal/* (read-only on Toolroll)
youi parity --css /tmp/toolroll-copy/src/server/console.css --prefix so
youi scan                                                 # usage map → /tmp/toolroll-copy/.youi/usage.json
youi where button
youi bom /settings
youi check
youi migrate pilot/toolroll/proposals/button-vocabulary.migration.yaml --diff   # dry run
node pilot/toolroll/verify-where.ts /tmp/toolroll-copy
youi sync --adopt                                         # writes the agent layer into the clone
```

## Results

Measured on an Apple M3 Pro with Node 26.0, against Toolroll `34aca05`.

| Check | Result |
| --- | --- |
| Token import | 75 DTCG tokens (49 from shipped CSS, 26 from DESIGN.md: radius, spacing, type); 0 colour mismatches |
| Token parity | the generated `tokens.css` matches all 92 `--so-*` declarations in `console.css` (light, dark media query, `data-theme="dark"`), 0 different, 0 missing |
| Scan time | 369 ms in process for 42 files; 0.66–1.09 s wall time for a cold `youi scan` CLI process (5 runs). Agreed target: under 10 s per PR scan |
| Usage map | 265 identity-resolved sites, 57 lookalikes, 5 unknown sites. Every site has a route: 254 are in a screen file, 8 reach a screen through imports, 3 are in the app shell, 0 are unrouted |
| `youi where button` vs reality | `verify-where.ts` agrees on every file: 128 owned-Button render sites, 39 sites that render the second Button in `ui/primitives.tsx` |
| Agent lookups (MCP, real Toolroll data) | `youi_where_used` 1.9 KB (10 sites per page), `youi_get_component Button` 2.3 KB, `youi_screen_bom /settings` 1.2 KB, `youi_get_rules` 2.3 KB, `youi_get_tokens typography` 1.8 KB, full colour palette 3.1 KB (40 tokens). Agreed target: about 2 KB |
| Rules | 97 errors and 306 warnings (see findings) |
| Codemod gates | the Button vocabulary dry run passed all five gates (128 → 128 sites); 6 sites left for a person |

## Agent test: build a screen with zero violations

A fresh agent (Claude Sonnet, no context from this work) was given only:
- the synced Toolroll clone, where `youi sync --adopt` had added the AGENTS.md block, the `youiyoux` skill and the generated DESIGN.md
- the `youi` CLI

Its task was a new `NotificationPreferences` screen with a title, a card of three alert channels (each with a status chip and an on/off control), a "Quiet hours" field, and three actions.

**Result:** it used `Card`, `Badge`, `Switch`, `Label`, `Input` and `Button` from the owned components directory, with legal prop values (`tone="success"`, `variant="outline"`, `variant="destructive"`, default ink for Save) and token type utilities (`text-display`, `text-body`). `youi check` on the new file reports **0 errors and 0 warnings**. A second, independent run of `youi check` confirmed this, and `youi where switch` lists the new Switch as unrouted (no screen imports it yet), rather than inventing a route.

What the test exposed, and what changed because of it:

1. **The token utilities did not exist in Toolroll's build.** Toolroll's Tailwind entry did not import the generated `theme.css`, so `text-display` and `text-body` compiled to nothing. Compiling Toolroll's CSS before and after adding the import showed this, and also showed that the first generator would have overridden Tailwind's own names (`max-w-2xl` would have become 24px). Now the generator never emits Tailwind-reserved names unless the project maps them explicitly. With the import added, every existing rule compiles identically and only the new utilities appear. `youi check` now warns when no stylesheet imports the theme.
2. The AGENTS.md block named an MCP tool the agent could not reach. Now it names `youi show <component>` as the fallback.
3. The skill did not mention the owned components that have no contract yet (Select, RadioGroup, DropdownMenu, …). Now it lists them.
4. The agent flagged that DESIGN.md never describes Button's `secondary` and `link` variants. The contract now says so, and finding F9 proposes a fix.
5. The rules do not check accessible names (for example, an icon-only button without `aria-label`). That is a candidate rule for the next phase.
