# youiyoux

**Your agent rebuilds components you already have. youiyoux catches it.**

UI context and verification for coding agents: it tells the agent what your repo already has before
it writes UI, then checks what it wrote.

```sh
npx youiyoux              # scan this repo
npx youiyoux path/to/repo # or another one; --out <dir> writes elsewhere
```

No config, no account. You get:

- `youiyoux-report.html`: near-duplicate components and which to keep, hardcoded values your theme already has, off-library imports, and the top fixes with their next steps. One offline page.
- `youiyoux-card.png`: a 1200×630 card with the headline numbers.
- `youiyoux-summary.md`: paste it into a PR or issue.

New to it? [Getting started](https://github.com/ap9000/youiyoux/blob/main/docs/getting-started.md): the report, the top fix, your agent and CI, in five steps.

## For your agent

```sh
npx youiyoux agents install   # rule in AGENTS.md + CLAUDE.md, MCP server for Claude Code + Codex
npx youiyoux hooks install    # check after each Claude Code edit, and at git commit
```

- `ui_find_component` (MCP): before writing a component, the existing one with its import, props and a real usage.
- `npx youiyoux check --diff`: after UI edits, what the change adds, each with its fix.
- `ui_render` (MCP) or `npx youiyoux render <file>`: screenshots light and dark, accessibility issues, a diff against base.

## The hub, screens and requests

```sh
npx youiyoux ui --project .                                   # the hub: your system, where it is used, your screens
npx youiyoux screens login --base http://localhost:3000       # once, if the app needs a sign-in
npx youiyoux screens capture --base http://localhost:3000     # photograph the routes in .youi/screens/screens.json
```

On the hub's Screens page, pick any component on a screenshot and leave a comment or a change request. Your agent reads it (`requests_list`), makes the change, captures the screen again (`screens_capture`) and marks it addressed; you compare before and after and close it.

## Check your popups work with a keyboard

```sh
npx youiyoux rules add behaviour                            # six popup rules, as warnings
npx youiyoux screens capture --base http://localhost:5173   # your dev app's screens
npx youiyoux ui                                             # Behaviour on a screen: switch probing on, run it
npx youiyoux behave                                         # or from the terminal; your agent uses ui_behave
```

It opens each menu and dialog on your dev app (http on this machine) in headless Chromium and checks that Esc closes it, focus moves in and comes back, Tab stays inside a dialog and arrow keys move. It clicks only the buttons that open popups and presses only Esc, Tab and the arrow keys. A failure says why and how to fix it. Details: [behaviour checks](https://github.com/ap9000/youiyoux/blob/main/docs/commands.md#behaviour-checks).

## Privacy

Runs locally; nothing is uploaded, no telemetry. The report includes relative paths, component names, class lists, counts and rendered images when available. No source lines unless `--include-code`; home paths, usernames, env values and credentials are stripped. Rendered looks need a headless Chromium (`--render` offers to download it, ~100 MB, once); specimen images are cached in `~/.cache/youiyoux/specimens`.

Node 20 or later. The `youi` bin is a silent alias.

Docs, agent reference and source: [github.com/ap9000/youiyoux](https://github.com/ap9000/youiyoux)
