# Toolroll findings from the YouIyouX pilot

**Scanned:** Toolroll `34aca05` ("Release 0.9.59"), a read-only clone. **Scope:** `src/browser/**/*.{ts,tsx,css}` and `src/server/**/*.css` (42 files). **Tool:** `youi scan`, `youi check`, `youi where` and `youi migrate` (dry run), using `pilot/toolroll/youi.project.json`.

These are proposals for Toolroll. Nothing here was changed in Toolroll. Each finding gives file:line and a suggested fix. Where a fix was checked, the check is described.

## Summary

| | Count |
| --- | --- |
| Design-system usage sites (identity-resolved) | 265 (Button 128, Input 64, Label 22, Textarea 19, Card 16, Badge 14, Switch 2) |
| Lookalikes (same name, different implementation) | 57 |
| Unknown sites (not resolvable statically, not counted) | 5 |
| Errors | 97 (57 lookalike imports, 40 raw colours) |
| Warnings | 306 (282 arbitrary values, 24 native controls) |
| Token parity: generated CSS vs `src/server/console.css` | 92 of 92 declarations identical (light, dark media query, `data-theme`) |

The biggest wins, in order:
1. One Button system instead of two (F1).
2. Wire the existing typography tokens into Tailwind (F2).
3. Let the generated `tokens.css` replace the hand-kept, duplicated token blocks (F9).

## F1. Two implementations of Button, Badge, Input, Label and Textarea

**Rule:** `components.canonical-import` (error). 57 sites.

`src/browser/ui/primitives.tsx:19` defines a second `Button`, plus `Badge`, `Input`, `Textarea` and `Label` (lines 34–43). They are styled by `.ui-button*` classes in `src/browser/workspace.css:48-56`, not by the shadcn components in `src/browser/components/ui`. The variants overlap in meaning but not in name: primitives use `primary | secondary | ghost | danger`, the owned Button uses `default | outline | ghost | destructive | …`. A fix to one Button never reaches the other.

Sites that render the primitive:
- `src/browser/app.tsx`: Button 356, 397, 399, 418, 420, 507 (×2), 529, 691, 692, 693, 700, 712, 723, 733, 744, 750; Label 334, 401, 510; Input 402; Textarea 517.
- `src/browser/team-chat.tsx`: Button 128, 144, 145, 150, 152, 155 (×2), 157 (×2), 162 (×2), 164 (×4), 172; Textarea 152, 155, 162 (×2), 164; Input 125, 152, 162 (×2); Badge 38, 154; Label 155, 164.
- `src/browser/first-run.tsx`: Button 15, 62, 96, 112.
- `src/browser/ui/conversation.tsx:21`, `src/browser/ui/workflow.tsx:54`: Button.

**Fix:**
1. Import from `./components/ui/index.js` instead of `./ui/index.js`.
2. Map the variants: `primary → default`, `secondary → outline` (both are a paper pill with the pill shadow, `workspace.css:51`), `ghost → ghost`, `danger → destructive`.
3. Then delete the primitive Button, Badge, Input, Textarea and Label (keep Dialog, Disclosure and Alert, which have no owned equivalent) and the `.ui-button*` rules.

The value mapping is a `youi.migration/v1` recipe. The import rewrite is not yet a recipe step, so today these 57 sites count as residuals for a person.

## F2. Typography tokens exist but are unreachable from Tailwind (282 arbitrary values)

**Rule:** `tokens.no-arbitrary-values` (warn).

Signal defines 11 type styles (DESIGN.md frontmatter `typography`), but `src/browser/tailwind.css:18-54` maps no `--text-*` names, so code copies the sizes by hand:

| Arbitrary value | Sites | Token utility |
| --- | --- | --- |
| `text-[13px]` | 144 | `text-body` (400) or `text-label` (500) |
| `text-[12px]` | 73 | `text-caption` or `text-mono` |
| `text-[11px]` | 13 | `text-mono-count` |
| `text-[15px]` | 11 | `text-title` |
| `text-[14px]` | 8 | `text-body-reading` or `text-title-sm` |
| `text-[11.5px]`, `text-[26px]` | 3, 3 | `text-badge`, `text-display` |
| `rounded-[10px]`, `rounded-[5px]` | 4, 4 | `rounded-card`, `rounded-badge` |
| `shadow-[var(--so-pill-shadow)]`, `shadow-[var(--so-shadow-overlay)]` | 4, 1 | `shadow-pill`, `shadow-overlay` |
| `bg-[var(--so-raised)]`, `accent-[var(--so-accent)]`, `bg-[var(--so-signal-hover)]` | 5, 5, 2 | `bg-secondary`, `accent-primary`, `bg-signal-hover` |

Where they are: `views/flow-view.tsx` 142, `views/settings-view.tsx` 30, `views/task-view.tsx` 23, `views/result-view.tsx` 22, `views/home-view.tsx` 18, `views/tasks-view.tsx` 15. The owned components carry them too: `components/ui/button.tsx:8`, `:22` (`text-[13px]`), `:13` (`bg-[var(--so-signal-hover)]`), `:15` (`shadow-[var(--so-pill-shadow)]`); `badge.tsx:6` (`rounded-[5px]`, `text-[11.5px]`); `card.tsx:6` (`rounded-[10px]`); `form-controls.tsx:11, 14`, `tabs.tsx:11`, `select.tsx:10, 21`, `radio-group.tsx:19` and `dropdown-menu.tsx:10, 13`.

**Fix:** add `@import "../design/theme.css";` after line 11 of `src/browser/tailwind.css`, so the generated theme is part of the build. Then replace the arbitrary values with the utilities above, choosing `body` or `label` per site (both are 13px; the weight differs).

**Checked:** I compiled Toolroll's Tailwind entry (tailwindcss 4.3.3) with and without the import. Every existing rule came out identical, and only the new utilities were added. That first compile is also why the generator no longer lets token names override Tailwind's own names: an early version would have turned `max-w-2xl` into 24px.

## F3. The composer and user bubbles use 16px corners; DESIGN.md says 12px

DESIGN.md (Shapes) says sheets, the composer, user chat bubbles and tab tracks are 12px. The code uses `rounded-xl`, which `src/browser/tailwind.css:53` defines as `--radius-xl: 16px`, a radius that is not in Signal's scale (5, 6, 8, 10, 12, 9999). Sites:
- `src/browser/app.tsx:586` (composer)
- `src/browser/views/task-view.tsx:208` (user bubble)
- `src/browser/views/flow-view.tsx:142`, `:1532`
- `src/browser/views/home-view.tsx:111`

**Fix:** use `rounded-lg` (12px, Signal's `radius.sheet`) and delete `--radius-xl`. Otherwise, if 16px is intended, add it to Signal and to DESIGN.md.

## F4. Status colour fallbacks that disagree with the tokens

**Rule:** `color.no-raw-color`. In `src/server/console.css`, `var(--x, #fallback)` fallbacks never apply, because the tokens are always defined, and their values are not Signal's:
- `:1176`: `var(--warning, #c98a1b)` ×2 (Signal warning is `#ab6400`)
- `:1181`: `var(--success, #2f9e5f)` (Signal success is `#218358`)
- `:1182`: `var(--danger, #c8453d)` (Signal danger is `#c4320a`)
- `:1183`: `var(--warning, #c98a1b)`
- `:1654`: `var(--success, #15803d)`

Separately, the literal `#ab6400` at `:220`, `:1065` and `:1655` is exactly `--so-warning`.

**Fix:** drop the fallbacks, and write `var(--so-warning)` for the three literals.

## F5. Shadows and overlays outside the shadow vocabulary

DESIGN.md defines three shadows (sheet, pill, overlay) and a scrim. These literal values do not match any of them:
- `src/server/console.css`: `:922` (`rgb(255 255 255 / .5)`), `:1046` (`/ .1`), `:2143` (`/ .8`), `:2168` (`/ .9` and white `/ .07`), `:2294` (white `/ .65`), `:2315` and `:2337` (`rgb(0 0 0 / .18)` backgrounds), `:2755` (`/ .35`)
- `src/browser/workspace.css:161` (`rgb(0 0 0 / .04)`)

**Fix:** move each to `shadow.sheet`, `shadow.pill`, `shadow.overlay` or `color.scrim` where it plays that role. Where it doesn't, propose a new token, so the vocabulary stays complete.

## F6. Flow lane and avatar colours are hard-coded

`src/browser/views/flow-view.tsx:28` defines `COLORS` with six Tailwind-palette hexes (`#64748b`, `#3b82f6`, `#8b5cf6`, `#d97706`, `#059669`, `#e11d48`), reused at `:1634`. `:25` builds avatar colours as `hsl(${hue} 45% 45%)`. None of them has a dark value or a contrast check, unlike every Signal colour.

**Fix:** add a categorical palette to Signal (`color.lane.slate`, …) with light and dark values and contrast checks, and read it through `cssVar` from the generated `tokens.ts`.

## F7. Literal colours that are correct, and should say so

- `src/browser/views/settings-view.tsx:87` and `:128`: the accent colour picker's saturation plane and hue strip must be literal colours.
- `src/browser/views/tasks-view.tsx:162`: `#000` in a mask gradient only sets opacity.

**Fix:** mark each with `// youi-ignore color.no-raw-color: <reason>`. A suppression is still counted (`suppressed` in the report), so the exception stays visible.

## F8. Native controls styled by hand (24)

**Rule:** `components.no-native-controls` (warn). `<button>` at:
- `src/browser/app.tsx:302, 303, 497, 735, 736`
- `src/browser/first-run.tsx:79`
- `src/browser/views/flow-view.tsx:166, 206, 340, 839, 1322, 1545, 1635`
- `src/browser/views/home-view.tsx:114`
- `src/browser/views/projects-view.tsx:42, 48`
- `src/browser/views/settings-view.tsx:51, 148, 438`
- `src/browser/views/status-summary.tsx:52`
- `src/browser/views/tasks-view.tsx:135`

Also `<textarea>` at `src/browser/app.tsx:588` (the composer), and the primitives' own `<input>` and `<textarea>` (`ui/primitives.tsx:38, 41`, covered by F1).

**Fix:** where a control is an act, render `Button` (`variant="ghost"` for toolbar icons, `asChild` for links). Where it is a bespoke widget (tab strips, canvas handles in the flow editor), keep it, add a `youi-ignore` with the reason, or give it a contract.

## F9. DESIGN.md and the CSS have drifted

1. `DESIGN.md:328` says every colour is "defined once, in `THEME_LIGHT` / `THEME_DARK` in `src/serve.ts`". No such symbols exist; the values live in `src/server/console.css:37-110`.
2. The frontmatter names `ink-hover` and `on-ink` (`DESIGN.md:15-16, 42-43`, and in component styles at `:137, :143, :250`). The CSS has no such variables; the code uses `--so-accent-hover` and `--so-on-accent` with the same values.
3. 24 shipped variables are missing from the frontmatter: accent, accent-hover, accent-text, attention, attention-soft, code-bg, ease-out, live, nav-current, nav-current-ink, on-accent, on-attention, overlay, the five phone-* spacings, pill-shadow, scroll, shadow-overlay, sheet-shadow, sidebar and user-bubble.
4. The dark token block appears twice, identically: `src/server/console.css:76-92` (prefers-color-scheme) and `:94-110` (`data-theme="dark"`). Every dark change has to be made twice.
5. Button's `secondary` and `link` variants (`components/ui/button.tsx:15, 18`) are not described in DESIGN.md, so an agent building UI cannot tell when to use them.

**Fix:** treat the Signal tokens in the design-language repo as the source. The generated `src/design/tokens.css` reproduces all 92 shipped declarations exactly, and writes the dark block once per selector from one definition, so it can replace `console.css:37-110`. The generated DESIGN.md frontmatter comes from the same tokens, so items 1–3 cannot recur. For item 5, document `secondary` and `link` or remove them.

## F10. Owned components with no contract yet

`src/browser/components/ui/select.tsx`, `radio-group.tsx`, `dropdown-menu.tsx`, `collapsible.tsx` and `sonner.tsx` are owned shadcn components with no contract. Their props are not checked and their uses are not in the usage map. The generated skill now lists them, so agents know they exist.

**Fix:** contract them next, starting with DropdownMenu and Select (used in the tasks, flows and settings views).

## Proposal checked by a dry run: Button vocabulary

`pilot/toolroll/proposals/button-vocabulary.migration.yaml` renames `attention → signal` and `destructive → danger`, so code and DESIGN.md use the same words. `youi migrate` (dry run) rewrote 5 sites in 3 files and passed every gate: parse errors, usage count 128 → 128, unknowns, old API, idempotence. It left 6 sites in `src/browser/views/result-view.tsx` (267, 279, 284, 286, 292, 295) and `src/browser/views/task-view.tsx:54` for a person, because the variant there is computed (`variant={variant}`) or props are spread. `youi plan` on the same change classifies it as api-breaking (Button 2.0.0): 14 affected call sites, 4 automatic, 10 by hand. This is a proposal, not a decision.
