# YouIyouX

The company design language and its tooling. Every token, component and rule has a stable id (`youi:<system>/<kind>/<name>`), a JSON contract, and a live map of where it is used in each product: file, line and screen. Every change is planned against those uses before it ships.

Phase 0 is CLI only: definitions in Git, the `youi` CLI, a scanner, and a local MCP server. The first system, **Signal**, is imported from Toolroll; see [`pilot/toolroll`](pilot/toolroll/README.md) and [the findings](pilot/toolroll-findings.md).

## Layout

| Path | Contents |
| --- | --- |
| `youi.config.json` | Systems and where their definitions live |
| `tokens/signal/` | DTCG 2025.10 tokens: `signal.resolver.json` (base set plus a light/dark `theme` modifier) |
| `components/<name>/` | `youi.component/v1` contracts and the owned implementations that sync vendors into products |
| `rules/` | `youi.rule/v1` rules: prose for people, an instruction for agents, and an executable check |
| `systems/signal/design.md` | Signal's narrative; DESIGN.md is generated from it plus the tokens |
| `schema/` | JSON Schemas, emitted from the Zod definitions in `packages/core` (`youi schema --write`) |
| `packages/` | `core` (schemas, loader), `tokens` (Terrazzo build, import, parity), `scanner` (usage map, checks, migrations, plans), `cli`, `mcp` |
| `pilot/` | The Toolroll pilot: config, import, cross-checks, findings |

## Use

Requires Node 24 or later; the TypeScript runs directly, with no build step.

```sh
pnpm install
pnpm test                       # vitest
pnpm typecheck
node packages/cli/bin/youi.js   # help
```

In a product repo:

| Command | Does |
| --- | --- |
| `youi init` | Write `youi.project.json` (detects Expo Router, the components directory and the `@/` alias), then sync |
| `youi sync` | Write tokens (`tokens.css`, Tailwind v4 `theme.css`, `tokens.ts`; React Native optional), DESIGN.md, the `youiyoux` skill and the AGENTS.md block; vendor owned components with 3-way merges; record `youi.lock.json` |
| `youi scan` | Build the `youi.usage/v1` usage map |
| `youi where <component>` / `youi bom <route>` | Where a component lives, screen by screen; everything on one screen |
| `youi show <component>` | The contract: import, legal values, guidance |
| `youi check` | Rules plus lockfile drift; exits 1 on errors |
| `youi plan` / `youi migrate` | Classify a change and its impact; run a gated codemod (dry run unless `--write`) |
| `youi mcp` | stdio MCP server: read tools plus `youi_plan`; no publish, approve or merge tools |

## Guarantees

- **Identity, not names.** A `<Button>` counts only if its import resolves (TypeScript module resolution, through barrels and aliases) to the owned implementation. A same-named component from elsewhere is reported as a lookalike.
- **Unknown is never zero.** Sites the scanner cannot resolve are listed as unknown, and a scan with files it could not parse is marked `partial`.
- **Rewrites are gated.** A migration is written only if the rewritten files parse cleanly, the element's usage count is unchanged, no site became unknown, no non-residual site keeps the old API, and a second run changes nothing.
- **Agents propose, people approve.** Agents get read tools and a planner; nothing in the agent surface can publish a change.
