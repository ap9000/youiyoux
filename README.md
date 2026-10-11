# YouIyouX

Tooling for a design language. Every token, component and rule has a stable id (`youi:<system>/<kind>/<name>`), a JSON contract, and a live map of where it is used in each product: file, line and screen. Every change is planned against those uses before it ships.

Phase 0 is local: the `youi` CLI, a scanner, a local MCP server and a web hub. No hosted service yet.

## The tool and the data live apart

This repository is the tool. It holds no product's design data: each design system lives in its own repository (a *design repo*), and `youi` reads it from a checkout, the way Terraform is a public tool that reads configuration it does not own.

| Lives | Where |
| --- | --- |
| The CLI, scanner, MCP server, hub and the published JSON Schemas | here |
| A system's tokens, component contracts and owned implementations, rules and narrative | its design repo |
| How a product uses a system (`youi.project.json`) | the product repo, or beside the system in its design repo |
| Scan results, permissions and approvals | the hosted database (not built yet); never in a repo |

A design repo is any directory with a `youi.config.json`. A product names it with `source.path` in its `youi.project.json` (relative to the config, or absolute), or any command takes `--design <dir>`. A design repo keeps the layout below; [`examples/demo-design`](examples/demo-design) is a complete one.

| Path in a design repo | Contents |
| --- | --- |
| `youi.config.json` | Systems and where their definitions live |
| `tokens/<system>/` | DTCG 2025.10 tokens: a resolver (base set plus a light/dark `theme` modifier) |
| `components/<name>/` | `youi.component/v1` contracts, the owned implementations that sync vendors into products, and an optional `<name>.demo.tsx` the hub previews |
| `rules/` | `youi.rule/v1` rules: prose for people, an instruction for agents, and an executable check |
| `library/` | `youi.library/v1` Library items (`library/<source>/<name>.library.json`): ingested references, never built with; none yet, sources come later |
| `systems/<system>/design.md` | The narrative; DESIGN.md is generated from it plus the tokens |
| `schema/` | Optional copies of this tool's JSON Schemas for editor validation (`youi schema --write --design .`; `--check` verifies them) |

## This repository

| Path | Contents |
| --- | --- |
| `packages/` | `core` (schemas, loader), `tokens` (Terrazzo build, import, parity), `scanner` (usage map, checks, migrations, plans), `cli`, `mcp`, `workflow` (rule-editor service) |
| `apps/web/` | The hub: find an element, see its contract, tokens and rules, preview it, see where it lives ([README](apps/web/README.md)) |
| `schema/` | JSON Schemas, emitted from the Zod definitions in `packages/core` (`youi schema --write`) |
| `examples/demo-design/` | **Demo**, a made-up design system (Button, Input and Card; 19 tokens; 6 rules) used by the tests, these docs and the hub's default data |
| `examples/demo-app/` | A made-up product that uses Demo, with a few deliberate violations |
| `.railway/`, `.github/workflows/web-preview.yml` | Per-PR preview deploys of the hub on Railway, demo data only ([how](apps/web/README.md#preview-deploys)) |

## Use

Requires Node 24 or later; the TypeScript runs directly, with no build step.

```sh
pnpm install
pnpm test                       # vitest
pnpm typecheck
node packages/cli/bin/youi.js   # help
alias youi="node $PWD/packages/cli/bin/youi.js"
```

Try it on the demo:

```sh
youi check --project examples/demo-app          # 1 error, 2 warnings
youi where button --project examples/demo-app   # 6 sites on 3 screens
youi ui                                         # the hub on the demo system: http://localhost:5173
```

In a product repo:

| Command | Does |
| --- | --- |
| `youi init --design <dir>` | Write `youi.project.json` pointing at a design repo checkout (detects Expo Router, the components directory and the `@/` alias), then sync |
| `youi sync` | Write tokens (`tokens.css`, Tailwind v4 `theme.css`, `tokens.ts`; React Native optional), DESIGN.md, the `youiyoux` skill and the AGENTS.md block; vendor owned components with 3-way merges; record `youi.lock.json` |
| `youi scan` | Build the `youi.usage/v1` usage map |
| `youi where <component>` / `youi bom <route>` | Where a component lives, screen by screen; everything on one screen |
| `youi show <component>` | The contract: import, legal values, guidance |
| `youi check` | Rules plus lockfile drift; exits 1 on errors |
| `youi plan` / `youi migrate` | Classify a change and its impact; run a gated codemod (dry run unless `--write`) |
| `youi library search <query>` / `youi library request <id> --reason …` | Browse the Library; draft a request to adopt an item into the System |
| `youi mcp` | stdio MCP server: `system_*` tools (build with these, plus `system_plan`) and `library_*` tools (browse, draft a request); no publish, approve or merge tools |
| `youi ui --project <dir>` | The hub on that product, with the local rule editor: drafts, impact preview against the project, approval, and a review branch in the design repo ([guide](packages/workflow/README.md)) |

`show`, `where`, `bom`, `check`, `plan` and `migrate` work on the System.

Every product command takes `--design <dir>` (override the design repo) and `--config <file>` (a project config kept outside the product, for example in the design repo).

In a design repo (the current directory, or `--design <dir>`):

| Command | Does |
| --- | --- |
| `youi build` | Build the token outputs (`--out`, `--prefix`) |
| `youi parity --css <file>` | Compare the generated CSS with a product's shipped CSS, light and dark |
| `youi schema --check` | Check the repo's `schema/` copies against this tool's schemas (`--write` refreshes them) |

Anywhere:

| Command | Does |
| --- | --- |
| `youi ui [--design <dir>] [--project <dir>] [--config <file>]` | Start the hub on a design system (default: the demo); with `--project`, plus that product's usage map from a read-only scan |

## Guarantees

- **Identity, not names.** A `<Button>` counts only if its import resolves (TypeScript module resolution, through barrels and aliases) to the owned implementation. A same-named component from elsewhere is reported as a lookalike.
- **Unknown is never zero.** Sites the scanner cannot resolve are listed as unknown, and a scan with files it could not parse is marked `partial`.
- **Rewrites are gated.** A migration is written only if the rewritten files parse cleanly, the element's usage count is unchanged, no site became unknown, no non-residual site keeps the old API, and a second run changes nothing.
- **Build with the System, browse the Library.** System elements (`youi:` ids) are approved: products and agents build only with them. Library items (`lib:` ids) are ingested references, kept to browse, categorize and propose as swaps; System lookups refuse them. An element moves `library → candidate → adopted → in-use`: an agent can only request adoption, a person approves it, and `in-use` is read off the usage map.
- **Agents propose, people approve.** Agents get read tools and a planner; nothing in the agent surface can publish a change.

## Roadmap (not built yet)

- **Library ingestion from links**: GitHub repos, Figma files, component catalogs, Storybook and DESIGN.md files, each categorized and reviewed before it lands in the Library.
- **Trial**: *Try alternatives* for an element, and *Try on a page* to see a candidate in a real screen before adopting it.
- **Replace with…**: swap one element for another across all of its uses, as a planned, reviewed change.
- **Screens, live**: screen snapshots with element positions, a live page view, and click-to-change on an element in place.
- **Hosted server**: on Railway, with logins, per-scope permissions, the Access page and a GitHub App; per-PR preview links for every change.
- **Public release prep**.

## License

None chosen yet; see [LICENSE](LICENSE). The repository is private.
