# Rule and style editor (`youi ui --project`)

Change a design rule, or a system's tokens and component states, safely: draft it, see exactly what it would change in the project, approve that revision, and hand it to review as a branch of the design repository. Local and single-user: one design repository and one registered project. Both kinds of draft share one store, one lifecycle and one approval policy.

```
save draft ─▶ impact preview ─▶ approve (a person) ─▶ review branch ─▶ PR, merge ─▶ agents and youi check use it
   │               │                    │
   │               │                    └─ withdrawn if the draft, the design repo's default branch or the project changes
   │               └─ draft and published rule run over one scan of the project
   └─ never publishes anything
```

- **Drafts** are files under the state directory (default `~/.youi/workflow/<hash>`), written atomically, so they survive restarts. Each is bound to the commit of the design repo's default branch it started from and to a digest of its content.
- **Preview** scans the project once and runs both the draft and today's rule over that snapshot: new places, places already flagged, places no longer flagged, plus what it cannot promise (unparsed files, advisory or off rules).
- **Approval** is a separate act. It records who approved, the revision, the preview and the exact design and project state. If any of those moves, the approval is withdrawn and the history says why.
- **Hand-off** creates `youi/rules/<rule>-<id>` in the design repository with git plumbing, based on the default branch (origin's HEAD, else main or master; never whatever is checked out). The default branch, the checked-out branch and the working tree are never touched, and nothing is pushed. The patch is kept beside the draft. A hand-off interrupted after creating the branch completes on retry.
- **Checks** run through the scanner's one rule execution model (the same as `youi check`, `youi rules` and the MCP server; `src/execution.ts` is the seam). The form offers the built-in checks (`raw-color`, `arbitrary-value`, `native-element`, `prop-values`, `lookalike-component`) or advisory; an existing ast-grep rule keeps its body as written. A check youi cannot run (an ast-grep body that does not compile, built-in options that would check nothing) cannot be saved as runnable or previewed, and a published rule that did not run never reads as "nothing breaks it".
- **Severity** can follow the plan "warn now, error later": `rollout: { to: error, after: YYYY-MM-DD }` in the rule file. Tightening is a later, separately approved edit.

## Style drafts

The hub's **Style** screen (`/style`) edits token values per scheme and re-binds component states; **Save draft** stores them as a style draft (`kind: "style"`), reviewed at `/changes/<id>`.

- **Content**: `tokens` (path → new light `$value` and/or dark `$value`, as written: a DTCG value or an alias like `{color.brand}`; `dark: null` drops a dark override so dark follows light; `light: null` is refused, since a token always has a light value) and `states` (component, state, role → token). Only existing tokens and existing state roles can change; adding tokens or states is a contract or token-file edit made by hand.
- **Validation**: each value against its type in `youi.tokens/v1` (`packages/core/src/tokens.ts`, including `spring` and `focusRing`), aliases that resolve to a token of the same type, no alias cycles, state tokens of the role's type. Font family names (alone or in a typography) may hold only letters, digits, spaces and hyphens, so no value can close a quote and add a CSS declaration.
- **Preview**: the token files at the draft's base commit are built twice in a throwaway directory, as published and as drafted. Every token whose resolved value differs in either scheme is a change (edited, or following through an alias). One fresh scan then gives the contracts that bind or implement them (at rest or in a state), **every** usage-map site of those contracts (file, line, screen), every direct use of their CSS variables and Tailwind utilities, the screens reached, and the colour pairs that fall below WCAG AA (4.5:1 for text, 3:1 for large text and focus rings) or recover. Large text is typography of 24px and up (18.66px bold): a contract set only in it, or a heading, display or title colour named like it. A focus ring drawn over its element (offset 0 or less) is checked against the fills of the contracts it focuses, state fills included, as well as the surfaces. A colour that cannot be read fails, with the reason. Totals always count everything; lists stop at 5,000 entries and the preview's limits say "Showing 5,000 of N".
- **Approval**: a style draft that puts colour pairs below WCAG AA that passed before (or did not exist) is approved only with `acknowledgeContrast`: exactly those pairs' keys. The hub asks once, in a dialog naming every pair; without it, or with other keys, `approve` is refused (422) naming each pair, its scheme and ratio against what it needs. The approval records the keys and the review branch's commit lists the pairs. Pairs that were already below AA are noted, not confirmed.
- **Hand-off**: `youi/style/<slug>-<id>`, made with the same plumbing as rule branches. Token files and contracts are edited in place (`src/json-edit.ts`): only the edited keys change, whatever the file's layout. A light edit goes to the file that gives the token its light value; a dark edit to the theme's dark file (a new override when the token had none). The default branch and the working tree are never written (tested in `test/style.test.ts`).

## Try it

From this repository, against Toolroll and a throwaway clone of its design repo (the editor writes branches into that clone; your real clones stay untouched):

```sh
git clone https://github.com/ap9000/toolroll-design.git ~/youi-rule-test/toolroll-design
pnpm install
pnpm youi ui --project ~/Documents/firstmate/projects/toolroll \
  --design ~/youi-rule-test/toolroll-design \
  --config ~/youi-rule-test/toolroll-design/pilot/toolroll/youi.project.json
# open the link it prints (http://localhost:5173/#key=…), then System → Rules
```

The link carries this run's key. Every change (save, preview, approve, hand-off) needs it, so another program on the machine cannot approve by calling the service; a tab opened without it can read but not change anything.

`youi ui` starts the service on a free loopback port and the hub's dev server proxies `/api` to it (`YOUI_API`). Drafts live in `--state <dir>` (default `~/.youi/workflow/<hash>`).

## Guided test (about 10 minutes)

1. **Edit an existing rule.** Open **Rules** (System → Rules): every rule with its check, level and the places Toolroll breaks it. Open *Use the owned controls, not native elements* and press **Edit rule** (element pages link here too). The draft opens on the rule's own page. Switch severity from Warning to **Error** and press **Save draft** (⌘S). The draft is now at revision 2. Nothing has changed in the design repo: `git -C ~/youi-rule-test/toolroll-design status` is clean.
2. **See the impact on Toolroll.** Press **Run preview**. Expect *Would flag 24 places in 9 files*, 24 *already flagged*, and a note that those 24 change from warnings to errors. Each place is listed with its file and line.
3. **Watch an approval go stale.** Press **Approve revision 2**, then change the title by one letter and save. The approval is withdrawn: History says *approval invalidated: the draft changed*, and the preview is marked out of date. Undo the edit, save, run the preview again and approve again.
4. **Send it for review.** Press **Create review branch**. You get the branch, its one-line diff (`-severity: warn` / `+severity: error`) and the `git push` / `gh pr create` commands. `git -C ~/youi-rule-test/toolroll-design log --oneline -1 main` is unchanged.
5. **Create a new rule.** In Rules, press **New rule**. Title *Views use token utilities*; the id fills itself in. Write a statement, a why and an agent instruction. Pick the check **Arbitrary values that copy a token** and set Files to `src/browser/views/**/*.tsx`. Leave *Plan to tighten it to an error* ticked and tick a component under *Components that follow it*. Preview: it flags only places in the views, all *new*, with a note about the later tightening. Approve and create the review branch: the diff adds the rule file and one line in the component's contract.
6. **Watch an agent pick it up.** In this test clone only, merge the branch from step 4 as a review would (`git -C ~/youi-rule-test/toolroll-design merge --ff-only <branch>`). Then:

   ```sh
   pnpm youi check --project ~/Documents/firstmate/projects/toolroll --design ~/youi-rule-test/toolroll-design \
     --config ~/youi-rule-test/toolroll-design/pilot/toolroll/youi.project.json --rule components.no-native-controls
   # 24 errors now, where there were 24 warnings

   claude -p "Use system_get_rules: what severity does the native-controls rule have, and what should I do instead?" \
     --allowedTools mcp__youiyoux__system_get_rules \
     --mcp-config "{\"mcpServers\":{\"youiyoux\":{\"command\":\"node\",\"args\":[\"$PWD/packages/cli/bin/youi.js\",\"mcp\",\"--project\",\"$HOME/Documents/firstmate/projects/toolroll\",\"--design\",\"$HOME/youi-rule-test/toolroll-design\",\"--config\",\"$HOME/youi-rule-test/toolroll-design/pilot/toolroll/youi.project.json\"]}}}"
   # the agent answers "error" and quotes the instruction
   ```

   A running agent session sees the merge within five seconds: the MCP server re-reads the definitions on the same freshness window as its scans. Back in Changes, the published list shows the new severity, and any other open draft says the default branch moved (**Rebase** to continue).
7. **Restart safety.** Stop `youi ui` (Ctrl-C) and start it again. Every draft, preview, approval and hand-off is still there. **Changes** lists them all as a queue: draft, waiting for approval, approved, sent for review, and rolled out (once the review branch is merged); opening one returns to its editor.

## API

`GET /api/info`, `GET /api/rules`, `GET|POST /api/drafts` (`{ mode: "edit", ruleId }`, `{ mode: "create" }`, or `{ kind: "style", content? }`), `GET|PUT|DELETE /api/drafts/:id`, `POST /api/drafts/:id/{preview,approve,rebase,handoff}` (approve takes `{ revision, previewId, acknowledgeContrast? }`). Loopback only: requests must name a loopback host and may not come cross-site; writes need this run's key in `X-Youi-Session` and, from a browser, a loopback origin; pages cannot be framed. `src/policy.ts` is the single authorization point: approving and handing off are a person's actions, and the MCP server has no tool for either. Same-user limits: a process that can read the terminal the service printed to, or write its state directory, can act as that person; hosted accounts replace this boundary.
