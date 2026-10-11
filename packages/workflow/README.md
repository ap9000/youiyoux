# Rule editor (`youi editor`)

Change a design rule safely: draft it, see exactly what it would flag in the project, approve that revision, and hand it to review as a branch of the design repository. Local and single-user: one design repository and one registered project.

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
- **Hand-off** creates `youi/rules/<rule>-<id>` in the design repository with git plumbing. The default branch, the checked-out branch and the working tree are never touched, and nothing is pushed. The patch is kept beside the draft.
- **Checks**: the form offers only checks the scanner runs today (`raw-color`, `arbitrary-value`, `native-element`, `prop-values`, `lookalike-component`) or advisory. `RuleExecution` in `src/execution.ts` is the seam where the shared rule execution model plugs in.
- **Severity** can follow the plan "warn now, error later": `rollout: { to: error, after: YYYY-MM-DD }` in the rule file. Tightening is a later, separately approved edit.

## Try it

From this repository, against Toolroll and a throwaway clone of its design repo (the editor writes branches into that clone; your real clones stay untouched):

```sh
git clone https://github.com/ap9000/toolroll-design.git ~/youi-rule-test/toolroll-design
pnpm install && pnpm -C apps/web build
pnpm youi editor --project ~/Documents/firstmate/projects/toolroll \
  --design ~/youi-rule-test/toolroll-design \
  --config ~/youi-rule-test/toolroll-design/pilot/toolroll/youi.project.json
# open http://127.0.0.1:4417/changes
```

For hub development, run `pnpm -C apps/web dev` beside it instead; it proxies `/api` to the service (`YOUI_API` overrides the address).

## Guided test (about 10 minutes)

1. **Edit an existing rule.** In Changes, under Published rules, press **Edit** on *Use the owned controls, not native elements* (or open the rule from Elements and press **Edit rule**). Switch severity from Warning to **Error** and press **Save draft** (⌘S). The draft is now at revision 2. Nothing has changed in the design repo: `git -C ~/youi-rule-test/toolroll-design status` is clean.
2. **See the impact on Toolroll.** Press **Run preview**. Expect *Would flag 24 places in 9 files*, 24 *already flagged*, and a note that those 24 change from warnings to errors. Each place is listed with its file and line.
3. **Watch an approval go stale.** Press **Approve revision 2**, then change the title by one letter and save. The approval is withdrawn: History says *approval invalidated: the draft changed*, and the preview is marked out of date. Undo the edit, save, run the preview again and approve again.
4. **Send it for review.** Press **Create review branch**. You get the branch, its one-line diff (`-severity: warn` / `+severity: error`) and the `git push` / `gh pr create` commands. `git -C ~/youi-rule-test/toolroll-design log --oneline -1 main` is unchanged.
5. **Create a new rule.** Press **New rule**. Title *Views use token utilities*; the id fills itself in. Write a statement, a why and an agent instruction. Pick the check **Arbitrary values that copy a token** and set Files to `src/browser/views/**/*.tsx`. Leave *Plan to tighten it to an error* ticked and tick a component under *Components that follow it*. Preview: it flags only places in the views, all *new*, with a note about the later tightening. Approve and create the review branch: the diff adds the rule file and one line in the component's contract.
6. **Watch an agent pick it up.** In this test clone only, merge the branch from step 4 as a review would (`git -C ~/youi-rule-test/toolroll-design merge --ff-only <branch>`). Then:

   ```sh
   pnpm youi check --project ~/Documents/firstmate/projects/toolroll --design ~/youi-rule-test/toolroll-design \
     --config ~/youi-rule-test/toolroll-design/pilot/toolroll/youi.project.json --rule components.no-native-controls
   # 24 errors now, where there were 24 warnings

   claude -p "Use youi_get_rules: what severity does the native-controls rule have, and what should I do instead?" \
     --allowedTools mcp__youiyoux__youi_get_rules \
     --mcp-config "{\"mcpServers\":{\"youiyoux\":{\"command\":\"node\",\"args\":[\"$PWD/packages/cli/bin/youi.js\",\"mcp\",\"--project\",\"$HOME/Documents/firstmate/projects/toolroll\",\"--design\",\"$HOME/youi-rule-test/toolroll-design\",\"--config\",\"$HOME/youi-rule-test/toolroll-design/pilot/toolroll/youi.project.json\"]}}}"
   # the agent answers "error" and quotes the instruction
   ```

   A running agent session sees the merge within five seconds: the MCP server re-reads the definitions on the same freshness window as its scans. Back in Changes, the published list shows the new severity, and any other open draft says the default branch moved (**Rebase** to continue).
7. **Restart safety.** Stop the service (Ctrl-C) and start it again. Every draft, preview, approval and hand-off is still there.

## API

`GET /api/info`, `GET /api/rules`, `GET|POST /api/drafts`, `GET|PUT|DELETE /api/drafts/:id`, `POST /api/drafts/:id/{preview,approve,rebase,handoff}`. Loopback only: requests must name a loopback host, and writes need an `X-Youi-Client` header and, from a browser, a loopback origin. `src/policy.ts` is the single authorization point: approving and handing off are a person's actions, and the MCP server has no tool for either.
