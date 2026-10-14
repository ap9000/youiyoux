# youiyoux

A shareable report on any repo's UI, with no setup:

```sh
npx youiyoux            # in a repo: scan it, write the report
npx youiyoux path/to/repo
```

It prints five plain-English lines and writes three files to the repo (or `--out <dir>`), and nothing else:

| File | What |
| --- | --- |
| `youiyoux-report.html` | One self-contained page (no network requests, light and dark, readable on a phone): projects (one section per workspace package with UI files), UI libraries, the component inventory, near-duplicate groups, hardcoded values a theme token already holds, off-library imports and the top fixes, each with a concrete next step |
| `youiyoux-card.png` | A 1200×630 share card with the repo's name and the headline numbers |
| `youiyoux-summary.md` | A short summary for a README or pull request |

**Rendered looks.** When a Chromium is installed (the Playwright headless shell, or `YOUI_CHROMIUM`), the most-used components are drawn with the project's own code and CSS and embedded. Otherwise the report says how: `npx youiyoux --render` asks before downloading the headless shell (~100 MB, once); `--yes` allows it without asking. Everything else works without a browser.

**Safe to share by default.** Paths are relative to the repo. Includes relative paths, component names, class lists, counts and rendered images when available. Captions and fixes omit literal prop values and text content; source lines require `--include-code`. Home paths, usernames, environment or `.env` values, and credentials in URLs are removed. `--include-code` adds source lines and full look captions (keys and tokens in it still removed).

**Set up youiyoux for your agent:** `npx youiyoux agents install` tells Claude Code and Codex to look up the project's existing components before writing new ones. Every other `youiyoux` command runs the same way (`npx youiyoux check --diff`), The `youi` bin remains a silent compatibility alias.

Node 20 or later. Nothing is uploaded, there is no telemetry and no account.

Specimen images are cached outside the repo in `~/.cache/youiyoux/specimens` (`XDG_CACHE_HOME` overrides `~/.cache`; `YOUI_SPECIMEN_CACHE` overrides the specimen directory). Rendered images show the component as rendered, including visible labels.
