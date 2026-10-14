# Working on youiyoux

For agents and people changing this repo. Using youiyoux in another repo is [docs/agents.md](docs/agents.md).

## Setup

Node 24 or later, pnpm 10 (`packageManager` pins the version).

```sh
pnpm install --frozen-lockfile
pnpm --filter @youiyoux/scanner exec playwright-core install chromium-headless-shell   # render tests
```

## Checks (all must pass before you finish)

```sh
pnpm typecheck
pnpm test
cd apps/web && pnpm test && pnpm build
node packages/cli/bin/youi.js schema --check
```

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Zod 4 schemas for every contract, ids, the loader |
| `packages/scanner` | Usage map, inventory, drift checks, rendering (specimens) |
| `packages/cli` | The `youiyoux` CLI; `src/report/` is `npx youiyoux` |
| `packages/mcp` | The MCP server (`ui_find_component`, `ui_render`, `system_*`, …) |
| `packages/detect`, `discover`, `tokens`, `store`, `workflow` | Library detection, Discover, token builds, the local index, the design-change service |
| `packages/youiyoux` | The npm package: the CLI bundled with esbuild for Node 20 |
| `apps/web` | The hub (Vite) |
| `schema/` | JSON Schemas generated from `packages/core` (`pnpm schemas`); never edit by hand |
| `examples/` | A made-up design system and app the tests use |
| `scripts/release.ts` | `pnpm release` ([docs/releasing.md](docs/releasing.md)) |

## Conventions

- **No build step.** Node runs the TypeScript directly: import with `.ts` extensions, and only
  erasable syntax (no `enum`, `namespace` or parameter properties). Only `packages/youiyoux`
  bundles, for Node 20: code it bundles must not import `node:sqlite`, `fs.glob`,
  `path.matchesGlob` or `util.styleText` (its pack test checks).
- **One schema per contract.** Add or change a contract in `packages/core` with Zod, then
  `pnpm schemas`; `schema --check` fails on a stale `schema/`.
- **Repo-controlled names never reach a path raw.** An id, name or slug read from a scanned repo
  goes through `safeId` (`packages/core/src/ids.ts`), or becomes a slug plus a hash, before it is
  part of a filesystem path. Refuse anything else by name; check output paths for escapes,
  including symlinks.
- **Shareable output is redacted.** The report goes through the `Redactor`
  (`packages/cli/src/report/safe.ts`): repo-relative paths only, no home paths, usernames, env
  values or credentials, no code unless `--include-code`.
- **Unknown is never zero.** If an analysis could not run, say so (`incomplete`, `partial`); never
  report it as a pass or a 0.
- **Every finding says what to do.** Plain English, a concrete fix or `Next:` step.
- **User-facing text says `youiyoux <command>`**, never `youi <command>` (a test checks). `youi`
  is a silent alias.
- **Writes are atomic** (`writeFileAtomic`); commands write only the files they say they write.

## Tests

Every change ships with tests (vitest; `packages/*/test`, `scripts/test`). Build fixture repos in
temp directories, never touch the network, and make each test fail without the change it covers:
a guard needs a test that shows it is active.

## Commits

Small and logical; the subject says what changed for a user. Never commit `dist/`, reports
(`youiyoux-*`) or `.youi/` output.
