# Getting started

Five steps, a few minutes, in a repo of your own: see what UI you already have, fix the worst of it,
then make sure your coding agent reuses it instead of building it again.

You need Node 20 or later and a React, Next.js or Astro app styled with Tailwind or CSS. Nothing to
install, no account; nothing leaves your machine. The output below is real, from a small Next.js app
with a `Button` component.

## 1. See what you already have

In the repo's root:

```sh
npx youiyoux
```

```text
acme-app: 1 project, 4 files scanned; UI libraries: none found.
Components: 1 defined, 4 buttons, inputs, cards and other UI elements in use; most used: Button (2 uses).
Near-duplicates: 1 group of UI that looks the same but is built more than once; 0 of them between exported components.
Hardcoded values: 1 colour, spacing or radius a theme token already holds; off-library imports: 0.
Top fix: 4 buttons look the same (40px high, 16px side padding, 6px corners, 14px text) but are built 2 ways; keep Button (src/components/ui/button.tsx); in src/app/billing/page.tsx, replace the hand-styled <button>s at lines 4, 5 with Button (import { Button } from "@/components/ui/button").

Report   youiyoux-report.html
Card     youiyoux-card.png
Summary  youiyoux-summary.md
```

It writes those three files and nothing else. Open `youiyoux-report.html` in a browser: every
finding says where it is and what to do, and the top fixes come first. The report is safe to share:
it holds relative paths, component names, class lists and counts, never your source lines, env
values or home paths.

The report draws your most-used components when your dependencies are installed and a headless
Chromium is available. Without one it says so; `npx youiyoux --render` offers to download one
(about 100 MB, once).

## 2. Fix the top finding

The top fix above says to keep `Button` and use it in the billing page, where two buttons were
styled by hand to look the same:

```diff
+import { Button } from "@/components/ui/button";
+
 export default function Billing() {
   return (
     <section className="space-y-4">
-      <button className="inline-flex items-center rounded-md font-medium h-10 px-4 text-sm bg-primary text-white">Upgrade</button>
-      <button className="inline-flex items-center rounded-md font-medium h-10 px-4 text-sm bg-primary text-white">Add card</button>
-      <p className="text-[#6b7280]">Billed monthly.</p>
+      <Button>Upgrade</Button>
+      <Button>Add card</Button>
+      <p className="text-muted">Billed monthly.</p>
     </section>
   );
 }
```

Run `npx youiyoux` again to see it clear:

```text
Near-duplicates: 0 groups of UI that looks the same but is built more than once; 0 of them between exported components.
Hardcoded values: 0 colours, spacings and radii a theme token already holds; off-library imports: 0.
Nothing to fix first; next: npx youiyoux agents install, so your agent keeps it that way.
```

On a real codebase there are more findings than this; work down the top fixes, a few at a time.
Each one is phrased "confirm it is the same role": if two things only look alike, leave them.

## 3. Tell your agent what you have

```sh
npx youiyoux agents install
npx youiyoux hooks install
```

| Writes | So that |
| --- | --- |
| A rule in `AGENTS.md` and `CLAUDE.md` | Your agent looks for an existing component before it writes one, and checks its UI edits |
| `.mcp.json` (Claude Code), `.codex/config.toml` (Codex) | Your agent can call the youiyoux MCP server |
| `.claude/settings.local.json` | After each Claude Code edit, what the edit adds comes back to Claude with its fix |
| `.git/hooks/pre-commit` | Each commit prints what its staged files add. It never blocks |

Commit the first two rows so the whole team gets them; the hooks stay on your machine. Restart your
agent so it loads the MCP server (Claude Code asks once before trusting a project's `.mcp.json`).
`npx youiyoux agents remove` takes the rule and the MCP entries out again.

Now, before your agent writes a component, it asks:

```text
> ui_find_component { "need": "primary button for inviting people" }

1 existing component in this project fits "primary button for inviting people" (looked at 1):
1. Use Button (hand-rolled): import { Button } from "@/components/ui/button";
   Why: name Button: button; tone="primary"
   Props: size: sm|md, tone: primary|ghost, className
   Example at src/app/billing/page.tsx:6:
     <Button>Upgrade</Button>
   Used in 4 places on 2 routes: src/app/billing/page.tsx:6 (/billing), src/app/billing/page.tsx:7 (/billing), src/app/settings/page.tsx:6 (/settings), src/app/settings/page.tsx:7 (/settings)
Next: import Button as shown and reuse it instead of writing a new component; open src/components/ui/button.tsx to confirm its props before using them.
```

## 4. Check what your agent writes

Agents still slip. Say one adds a team page with its own button and a hex colour. After UI edits it
runs (and you can too):

```sh
npx youiyoux check --diff
```

```text
youiyoux check --diff against HEAD: 1 changed file
src/app/team/page.tsx
  5:7  near-duplicate  A hand-styled <button> that looks like the existing Button (src/app/billing/page.tsx:6): 40px high, 16px side padding, 6px radius, 14px text. Confirm it is the same role; if so, render Button instead.
      → use <Button> from "@/components/ui/button"
  6:27  hardcoded value  Hardcoded colour #6b7280: the token color.muted has this value. Check it plays that role.
      → use text-muted (color.muted)
note: Repository inference uses existing components, library imports and declared theme variables. Run `youiyoux init --design <dir>` to add design-system rules.

✖ 2 findings in this change: apply each fix (→), then run `youiyoux check --diff` again
```

It looks only at what the change adds (the working tree against `HEAD`, new files included), never
at the debt already in the repo. Apply each fix, run it again, and stop when it says
`No drift in this change`.

## 5. Check every pull request

`check --diff <base> --strict` checks a branch against where it left `base`, and exits 1 on any
finding. A GitHub Actions workflow, `.github/workflows/youiyoux.yml`:

```yaml
name: youiyoux
on: pull_request
permissions:
  contents: read
jobs:
  ui:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y youiyoux check --diff origin/${{ github.base_ref }} --strict --format github
```

`--format github` puts each finding on its line in the pull request. Leave out `--strict` to get the
notes without ever failing the build (every note is then a warning). Pin a version
(`npx -y youiyoux@0.1.21`) so a new release never changes what fails your build.

## Where next

| To | Run |
| --- | --- |
| See a component you changed, light and dark, desktop and phone, with accessibility issues and a diff against main | `npx youiyoux render <file>` ([Render](commands.md#render)) |
| Make your components and stylesheet variables a design system, kept in the repo | `npx youiyoux adopt` ([adopt](commands.md#the-tool-and-the-data-live-apart)) |
| Browse your system, where each part is used, and your screens | `npx youiyoux ui --project .` |
| Find which UI libraries a repo or a live site uses | `npx youiyoux detect <path or url>` ([Detect](commands.md#detect)) |

Every command and flag: [commands.md](commands.md). What your agent sees and how it reads the
output: [agents.md](agents.md).

## If something looks wrong

- **"No component could be drawn".** Install the repo's dependencies (`pnpm install`, `npm install`
  or `yarn`), then run `npx youiyoux` again.
- **`check --diff` stops and says it needs git.** It compares against a commit; run it in a git
  checkout (`git init` and a first commit for a new repo).
- **A finding is wrong.** Skip it, and [open an issue](https://github.com/ap9000/youiyoux/issues)
  with the finding's text from `youiyoux-summary.md`. It holds no source code.
