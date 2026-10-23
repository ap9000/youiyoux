# youiyoux command reference

Everything `youiyoux` does, in detail. Start with the [README](../README.md); agents, see
[agents.md](agents.md). `youiyoux --help` prints the same commands in short.

## The report (`npx youiyoux`)

The first run needs no setup: in any repo, with no `youi.project.json` and nothing installed,

```sh
npx youiyoux                 # scan this repo and write the report
npx youiyoux path/to/repo    # or another one; --out <dir> writes the files elsewhere
```

It prints five plain-English lines (what it found and the top fix), then writes three files and nothing else into the repo:

| File | What |
| --- | --- |
| `youiyoux-report.html` | One self-contained page to open or send: inline CSS, images as `data:` URIs, no scripts and a `default-src 'none'` policy, so it makes no request; light and dark; readable on a phone. Projects (a monorepo gets one section per workspace package with UI files), UI libraries ([detect](#detect)), the component [inventory](#inventory), near-duplicate groups, hardcoded values a theme variable already holds, off-library imports and the top fixes ranked by the places they touch, each with a concrete `Next:` step, and the one line that sets up youiyoux for your agent (`npx youiyoux agents install`) |
| `youiyoux-card.png` | A 1200×630 share card with the repo's name and the headline numbers, drawn without a browser. Its duplicate count is groups of two or more exported components that look alike or share a name; the report lists every near-duplicate |
| `youiyoux-summary.md` | A short summary for a README or pull request |

The findings are `youiyoux check --diff`'s repo-mode analyses run over every line instead of a change's added ones: the same near-duplicate families, token matches and library choices. A near-duplicate group needs two or more distinct definitions (components, kit classes or hand-styled elements) in different files: uses of one component, including one imported from a workspace package or alias that does not resolve without `node_modules`, never make one. Each fix keeps one definition and never applies to the keeper's own file; imports it suggests are checked to resolve, and hand-styled elements are pointed at the project's shared component for that role or at a named new file to extract one into. A hardcoded value is matched to a token of the same value and group, the general scale before a component's own token (`gap: 8px` → `--spacing-2`, not `--spacing-button-gap`); gradients and colour lists in scripts (a colour picker) are not flagged. **Rendered looks**: when a Chromium is installed (the headless shell [render](#render) uses, or `YOUI_CHROMIUM`), the most-used components are drawn light and dark and embedded; otherwise the report says how to turn them on. `--render` downloads the headless shell (~100 MB, once) after asking, or with `--yes`; it is never bundled and never downloaded silently. **Safe to share by default**: paths are repo-relative, and the outputs include relative paths, component names, class lists, counts and rendered images when available. Captions and fixes omit literal prop values and text content; source lines require `--include-code`. Absolute or home paths, usernames, environment or `.env` values, and credentials in URLs are removed; a final pass refuses to write anything that still does. `--include-code` adds source lines and full look captions, with keys and tokens in it still removed. A medium repo (about 800 files) takes a few seconds without rendering. Specimen images are cached outside the repo in `~/.cache/youiyoux/specimens` (`XDG_CACHE_HOME` overrides `~/.cache`; `YOUI_SPECIMEN_CACHE` overrides the specimen directory). Rendered images show the component as rendered, including visible labels. Nothing is uploaded; no telemetry, no account.

The `youiyoux` package (`packages/youiyoux`) bundles the CLI as plain JavaScript for Node 20 or later; its bins are `youiyoux` (the report, or any other `youiyoux` command: `npx youiyoux check --diff`) and `youi`. `pnpm pack` in `packages/youiyoux` builds it (esbuild, `prepack`); [releasing.md](releasing.md) says how it is published.

## The tool and the data live apart

This repository is the tool. It holds no product's design data: each design system lives in its own repository (a *design repo*), and `youiyoux` reads it from a checkout, the way Terraform is a public tool that reads configuration it does not own.

| Lives | Where |
| --- | --- |
| The CLI, scanner, MCP server, hub and the published JSON Schemas | here |
| A system's tokens, component contracts and owned implementations, rules and narrative | its design repo |
| How a product uses a system (`youi.project.json`) | the product repo, or beside the system in its design repo (then `root` or `--root` names the product) |
| Scan results, permissions and approvals | the hosted database (not built yet); never in a repo |

A design repo is any directory with a `youi.config.json`. A product names it in its `youi.project.json` with `source.path` (relative to the config, or absolute), or with `source.package`: an npm package that holds `youi.config.json`, found in the product's `node_modules` or a parent's (a published design package, or a monorepo's workspace package), so the config names no one's folders; or with `source.git` and `source.ref`: a repository (`github:acme/design`, `https://…`, `git@host:path`, `ssh://…` or `file://…`; no other transport) at a tag, branch or commit. A git source is fetched into `~/.cache/youiyoux/systems` (`YOUI_SYSTEMS_CACHE`), one tree per commit, and used offline from then on: at the commit `youi.lock.json` records, so a teammate's fresh clone gets the same design, else where the ref last resolved. `youiyoux sync` fetches and resolves the ref again and records the new commit, as an update moves a lockfile; git never prompts, so a private repository needs your usual credentials (a credential helper or an ssh key). Any command also takes `--design <dir>`.

Commands find their project as git finds a repository: run anywhere inside a product, they use the nearest folder upward holding `youi.project.json`, without leaving the git repository. It fails closed, as git does: outside a git repository nothing above the current folder is used, and a config another user owns is ignored, so a file left in a shared folder such as `/tmp` is never read. `build` and `parity` find the nearest `youi.config.json` the same way. `--project`, `--config` or `--root` (and `--design`) still say where explicitly, and win. A design repo keeps the layout below; [`examples/demo-design`](../examples/demo-design) is a complete one.

| Path in a design repo | Contents |
| --- | --- |
| `youi.config.json` | Systems and where their definitions live |
| `tokens/<system>/` | `youi.tokens/v1` tokens: DTCG 2025.10 plus two youi types, `spring` (stiffness, damping, mass, velocity) and `focusRing` (colour, width, offset, style); a resolver (base set plus a light/dark `theme` modifier). Values that reach CSS are kept from injecting declarations: token names and font family names hold only letters, digits, spaces (families) and hyphens |
| `components/<name>/` | `youi.component/v1` contracts (with optional `states`: hover, active, focus and disabled → role → token), the owned implementations that sync vendors into products, and an optional `<name>.demo.tsx` the hub previews |
| `rules/` | `youi.rule/v1` rules: prose for people, an instruction for agents, and an executable check |
| `library/` | `youi.library/v1` Library items (`library/<source>/<name>.library.json`): ingested references, never built with; none yet, sources come later |
| `systems/<system>/design.md` | The narrative; DESIGN.md is generated from it plus the tokens |
| `schema/` | Optional copies of this tool's JSON Schemas for editor validation (`youiyoux schema --write --design .`; `--check` verifies them) |

## This repository

| Path | Contents |
| --- | --- |
| `packages/` | `core` (schemas, loader), `tokens` (Terrazzo build, import, parity), `scanner` (usage map, checks, migrations, plans), `detect` (which UI libraries a repo or website uses), `discover` (find UI components by need across shadcn registries and npm), `store` (the local index: derived data on SQLite, or Postgres with `DATABASE_URL`), `cli`, `mcp`, `workflow` (design-change service: rule, style and library drafts), `youiyoux` (the publishable package: the CLI bundled for `npx youiyoux`) |
| `apps/web/` | The hub: find an element, see its contract, tokens and rules, preview it, see where it lives ([README](../apps/web/README.md)) |
| `schema/` | JSON Schemas, emitted from the Zod definitions in `packages/core` (`youiyoux schema --write`) |
| `examples/demo-design/` | **Demo**, a made-up design system (Button, Input and Card; 29 tokens including motion, springs and a focus ring; states on Button and Input; 6 rules) used by the tests, these docs and the hub's default data |
| `examples/demo-app/` | A made-up product that uses Demo, with a few deliberate violations |
| `.railway/`, `.github/workflows/web-preview.yml` | Per-PR preview deploys of the hub on Railway, demo data only ([how](../apps/web/README.md#preview-deploys)) |

## Running from a checkout

Requires Node 24 or later (pnpm 10.13.1); the TypeScript runs directly, with no build step. The published `youiyoux` package is a bundle that runs on Node 20 or later.

```sh
pnpm install
pnpm test                       # vitest
pnpm typecheck
node packages/cli/bin/youi.js   # help
alias youiyoux="node $PWD/packages/cli/bin/youi.js"
```

Try it on the demo:

```sh
youiyoux check --project examples/demo-app          # 1 error, 2 warnings
youiyoux check --diff main                          # in a product repo: only what this branch adds, with fixes
youiyoux where button --project examples/demo-app   # 6 sites on 3 screens
youiyoux ui                                         # the hub on the demo system: http://localhost:5173
```

In a product repo:

| Command | Does |
| --- | --- |
| `youiyoux init --design <dir\|package>` | Write `youi.project.json` pointing at a design repo checkout, or at the installed npm package that holds it (`source.package`; a folder of that name wins), detecting Expo Router, the components directory and the `@/` alias, then sync |
| `youiyoux sync` | Write tokens (`tokens.css`, Tailwind v4 `theme.css`, `tokens.ts`; React Native optional), DESIGN.md, the `youiyoux` skill and the AGENTS.md block; vendor owned components with 3-way merges; record `youi.lock.json` (with a git source's commit, after fetching and resolving its ref again) |
| `youiyoux scan` | Build the `youi.usage/v1` usage map |
| `youiyoux where <component>` / `youiyoux bom <route>` | Where a component lives, screen by screen; everything on one screen |
| `youiyoux show <component>` | The contract: import, legal values, guidance |
| `youiyoux check` | Rules plus lockfile drift; exits 1 on errors |
| `youiyoux check --diff [base] [--strict] [--json] [--format github]` | Only what a change adds: the working tree against HEAD, or against the merge-base with `base` (`--diff main`). Flags a new component that near-duplicates an existing one (same role, every shape dimension within the [inventory](#inventory)'s tolerance; fix: `use <Button variant="ghost"> from "@/components/ui"`), a hardcoded colour, spacing or radius a token holds (fix: `use rounded-control (radius.control, var(--demo-radius-control))`), and an import that brings an element in from a library other than the project's choice (the System's component, else the library the rest of the code imports it from, read by [detect](#detect)), plus rule violations on added lines. Each finding has its fix, and the output says what to do next. Exits 0 (advisory) unless `--strict`, then 1 on any finding or an incomplete check. Without git it stops and says why |
| `youiyoux hooks install [--claude] [--git] [--ci [--diff]] [--strict]` | Wire the checks in, keeping existing config. Claude Code (PostToolUse): after each Edit/Write/MultiEdit of a checked file, only the findings on its added or changed lines go back to Claude, each with its fix; never blocks. git pre-commit: the staged files and the drift their staged lines add (`--strict` blocks on new findings or incomplete analysis). Codex has no documented post-edit hook, so no native post-edit hook is installed for it: it follows AGENTS.md (which tells agents to run `youiyoux check --diff`) and meets the pre-commit hook. `--ci` writes a pinned GitHub workflow; with `--diff`, pull requests also run `youiyoux check --diff origin/<base> --strict --format github` |
| `youiyoux plan` / `youiyoux migrate` | Classify a change and its impact; run a gated codemod: a dry run that prints the diff and the residual sites unless `--write` ([migrations](#migrations)) |
| `youiyoux library search <query>` / `youiyoux library request <id> --reason …` | Browse the Library; draft a request to adopt an item into the System |
| `youiyoux discover sync [--icons]` | Build the local Discover index (`~/.cache/youiyoux/discover`, or `--cache` / `YOUI_DISCOVER_CACHE`): the official shadcn registry, the registry directory and selected community registries (defaults: coss, Kibo, Magic UI, Aceternity; a chosen one the directory no longer lists is reported with how to drop it), headless catalogs for category names, npm search, and npm and GitHub signals. A registry's licence is its GitHub repository's, credited only when the two link both ways: the registry's homepage links the repository and the repository's homepage is that site (else a search result whose homepage is exactly the registry's); no such repository leaves it unknown. GPL and AGPL are marked copyleft. Polite (capped concurrency, timeouts, ETag/If-Modified-Since, npm/GitHub rate budgets, npm 429 backoff) and cached. Icon sets require `--icons`; mirrors collapse to originals. Reports total metadata catalog size. `GITHUB_TOKEN`, when set, is sent to GitHub only and never stored or printed |
| `youiyoux discover "<need>" [--role r] [--license spdx,…] [--limit n] [--offset n] [--json]` / `youiyoux discover show <id\|ref>` | Candidates for a need, ranked by match (names and aliases: command menu = command palette = cmdk, toast = snackbar…) plus signals, each with its licence (SPDX with evidence, or unknown), downloads (labeled with the dependency package when borrowed), stars and install command, paged, with facets (role, source, licence, headless/styled); one candidate with provenance and its npm, registry and implicit dependencies. Reads the local index (the store, loaded from the synced JSON); nothing is installed |
| `youiyoux discover sources [list\|add\|remove] <name>` | Choose community sources. Add validates against the cached directory; run sync first. Choices persist across syncs |
| `youiyoux discover "<need>" --all` | Fetch other healthy directory listings on demand, then reuse their cached metadata on repeat searches. They are kept apart (`index-all.json`, scope `all` in the store), so a search without `--all` stays on the chosen sources; under `--all` each source class is narrowed on its own, so community bulk never pushes official items out. Icon sets still require `--icons`; unsafe URLs are refused |
| `youiyoux requests [--status open\|addressed\|closed\|all] [--route r] [--json]` / `requests show <id>` / `requests reply <id> --message <text>` / `requests addressed <id> --message <what changed>` | The comments and change requests people pinned to components on captured screens in the hub (`<product>/.youi/requests/<id>.json`, `youi.request/v1`): what is asked, the route, component and file:line, whether it means this one or every use of the element, the screenshot and the box on it, the thread, and what to do next. Reply, or mark one addressed with what you changed, as an agent; a person closes or reopens it in the hub. The MCP tools `requests_list`, `request_reply` and `request_addressed` do the same. A file that is not a valid request is listed as unreadable (exit 1), never dropped. Filing one keeps the screen as it was (`<id>.before.webp`); after a change, `youiyoux screens capture --route <route>` gives the hub the picture to compare |
| `youiyoux screens capture --base <url> [--route r] [--project dir] [--out dir] [--storage-state file] [--json]` | Photograph the routes (or with `--route`, just one: after a change, the screen it touched, so a request shows before and after) in `<project>/.youi/screens/screens.json` (or `--out`) from the app running in development at `<url>`, light and dark, whole pages up to six viewports, as WebP beside it; and place each React component on them with the file and line that rendered it (from React's development stacks through the served source maps), as `<slug>.places.json`. `youiyoux ui --project` then outlines the System elements and lookalikes on each screen, selectable. A production build is placed without lines and says so; so does a development build whose components get no line, with why (scripts with no source maps, maps that cannot be read, or maps naming files outside the root) and the fix for its bundler. A route that fails is reported and the rest go on. Where the app ran is kept in `screens.json` (`base`), so the MCP tool `screens_capture` can capture one route again without asking. Behind a sign-in, `youiyoux screens login` once, or pass a Playwright storage state |
| `youiyoux screens login --base <url> [--project dir] [--storage-state file]` | Open the app in a browser window (Google Chrome, or `YOUI_CHROMIUM`) to sign in once; press Enter in the terminal when signed in. The session (cookies and storage) is kept outside the product, readable only by you, under `$XDG_CACHE_HOME/youiyoux/sessions` (`~/.cache`), named by the product's root; `screens capture` and `screens_capture` use it from then on, and say so. Delete the file to capture signed out |
| `youiyoux discover previews [--port n] [--registry @shadcn\|all] [--role r] [--limit n] [--force]` | Photograph candidates in your project's theme, light and dark, for the hub's Discover gallery, from a hub running on your project (`youiyoux ui --project <dir>`; `--port` if not 5173). Each registry item (official ones by default) is opened as Preview in your theme opens it (only its source fetched, run only in the hub's sandboxed frame, headless, other hosts blocked) and kept as WebP under the Discover cache's `thumbs/`. Current pictures are kept, a candidate that cannot be drawn on its own is recorded with why (a package nobody has, a part it needs, nothing visible alone) and not tried again until it changes; `--force` takes them all again. From npm, a package a candidate needs that the project lacks is not carried, so it says so rather than drawing it |
| `youiyoux discover show <id\|ref> --source` | Fetch and cache just that registry item's files. The ordinary catalog contains metadata, file hashes and detected imports, with no inline source or raw response bodies |
| `youiyoux agents install\|remove [--claude] [--codex]` | Tell coding agents to use what exists: a marked rule in AGENTS.md and CLAUDE.md ("call `ui_find_component` before creating a component") and the `youiyoux` MCP server registered for Claude Code (`.mcp.json`, the same entry `youiyoux sync` writes) and Codex (a marked block in `.codex/config.toml`); both unless one is named. Idempotent; `remove` takes out only youi's block or key and deletes files youi created, so the files read as before. A `[mcp_servers.youiyoux]` table youi did not write is refused, with the `codex mcp add` line instead. Works with or without `youi.project.json` |
| `youiyoux mcp` | stdio MCP server: `ui_find_component` (call it before creating a component: the project's existing components for a need in words, best first, each with its import line, props, a real usage snippet, where it is used and its library, from the System, shadcn, Radix or hand-rolled; class kits include their stylesheet and real class usages; call APIs lead with how to call toast() and where its provider is already mounted; library labels are per component, and a Lacks line explains how to add a requested missing capability; names and aliases count, so toast = snackbar and dialog = modal; or "nothing fits" with a primitive the project already uses or Discover candidates to start from; read live from the code, with or without `youi.project.json`), `system_*` tools (build with these, plus `system_plan`), `library_*` tools (browse, draft a request), read-only `discover_search` / `discover_show`, and read-only `index_where_used` (family), `index_swap_impact` (candidate, family) and `index_rule_covers` (rule), which answer from the local index in about ten lines, and `ui_render` (target, base): what `youiyoux render` prints, with absolute image paths ([render](#render)); no publish, approve, merge or install tools |
| `youiyoux index path\|stats\|rebuild\|history [project]` | The local index ([store](#the-local-index)): where it is, rows per table, delete and rebuild it from its sources, and inventory trends per project |
| `youiyoux ui --project <dir>` | The hub on that product, with the local rule and style editors: drafts, impact preview against the project, approval, and a review branch in the design repo ([guide](../packages/workflow/README.md)) |

`youiyoux check --diff` also works without `youi.project.json`: it infers components, library choices and declared CSS/Tailwind theme variables from the repo. Pass `--project <dir>` to limit it to one product; otherwise it finds the git root. No Tailwind default is treated as a project token. Run `youiyoux init --design <dir>` to add design-system rules. If a chosen library has a project wrapper, fixes name that wrapper. Components that compose existing components are not near-duplicates.

Generated agent instructions use `npx --no-install youiyoux check --diff` when the project declares `@youiyoux/cli`, otherwise `npx -y youiyoux check --diff`. They contain no machine-specific CLI path; local hooks keep their installed path.

The post-edit hook lists only findings on lines added or changed against HEAD, with older findings reduced to one count. An edit adding no findings is silent. `hooks install --claude --git` works in repo mode too, adding the post-edit check instruction to AGENTS.md for agents such as Codex. For CI without a config, run `youiyoux check --diff <base> --strict --format github` after checking out full git history; installing the pinned design-rule workflow still requires `youiyoux init --design <dir>`.

`show`, `where`, `bom`, `check`, `plan` and `migrate` work on the System.

Every product command takes `--design <dir>` (override the design repo), `--config <file>` (a project config kept outside the product, for example in the design repo) and `--root <dir>` (the product root, when the config does not sit in it).

A config kept outside its product names the product's root:

| Setting | Where | Wins over |
| --- | --- | --- |
| `--root <dir>` | any product command | everything below |
| `"root"` in `youi.project.json` | relative to the config file, or absolute | `--project` |
| `--project <dir>` | where the config is looked for, and the root when nothing above is set | the current directory |

```sh
youiyoux check --project ~/src/acme-design/pilot/acme-app --root ~/src/acme-app
```

If the root is not a directory, or none of its files match `include`, the command stops and names the root, the config and how to set `root`; it never reports 0 files as a pass. A real run on Toolroll is recorded in [docs/real-world-check.md](real-world-check.md).

In a design repo (the current directory, or `--design <dir>`):

| Command | Does |
| --- | --- |
| `youiyoux build` | Validate the token files with `youi.tokens/v1` and build the outputs (`--out`, `--prefix`): springs become a CSS `linear()` easing plus its settle duration, focus rings an outline shorthand plus offset, and contract states `--<prefix>-<component>-<state>-<role>` variables. Family names are written as escaped CSS strings and descriptions as comments that cannot be closed early. Unsafe system ids are refused by name, and output paths are checked for escapes, including symlinks |
| `youiyoux parity --css <file>` | Compare the generated CSS with a product's shipped CSS, light and dark |
| `youiyoux schema --check` | Check the repo's `schema/` copies against this tool's schemas (`--write` refreshes them) |

Anywhere:

| Command | Does |
| --- | --- |
| `youiyoux report [path] [--out <dir>] [--render [--yes]] [--include-code] [--json]` | The zero-setup report `npx youiyoux` runs ([above](#the-report-npx-youiyoux)): youiyoux-report.html, youiyoux-card.png and youiyoux-summary.md in the repo or `--out`, five summary lines, the paths and what to do next |
| `youiyoux inventory [--project <dir>…] [--include <glob>…] [--exclude <glob>…] [--out <file>] [--json]` | Every UI element across one or more projects, with no design system: definitions, kits, library primitives and each rendered look grouped into families by shape ([inventory](#inventory)). Each run is recorded in the local index (project, commit, time, counts, families); `youiyoux inventory --history` shows the trend |
| `youiyoux gaps [--project <dir>…] [--inventory <file>] [--json] [--out <file>]` | What each project adds next (`youi.gaps/v1`): for every kind of element Discover knows (date picker, combobox, toast…), whether it is in the System (a component named for it), from a library (a package built for it, imported or declared in `package.json`), built by hand (its own components named for it, by whole name or last words, so `ConfirmDialog` is a dialog and `DialogContent` is not; plus the native elements it styles as one), or missing, only for kinds the standard kit (shadcn/ui's set) has. Built-by-hand kinds come first, most uses first, with their files; each gap gets up to three licensed candidates from the local Discover index (never an unknown licence; copyleft after the rest, and marked), and kinds built by hand in more than one project are listed once, as worth adding to the System. Without `youiyoux discover sync` there are no candidates, and it says so. A partial inventory makes the counts a lower bound, and says so. The hub shows the same on Library > Gaps |
| `youiyoux ui [--design <dir>] [--project <dir>] [--config <file>] [--root <dir>] [--inventory <file>] [--detect <file>]` | Start the hub on a design system (default: the demo); with `--project`, plus that product's usage map from a read-only scan; with `--inventory`, that inventory on the Inventory page; with `--detect`, a `youiyoux detect` report on Library > Stack, whose library names (shadcn, Radix) the Inventory page's library filter then uses. From npm (`npx youiyoux ui`) it is the hub built into the package, served by its own server on this machine only, with the named system's snapshot in a temporary directory removed when it stops; component previews carry React, Radix, cva, clsx, tailwind-merge and lucide-react, and a demo that imports anything else says so in its place. From a checkout it is the Vite dev server |
| `youiyoux render [file\|component…] [--base <ref>] [--json]` | See a component after changing it: its looks drawn with the project's own code and CSS in headless Chromium, light and dark at 1280 and 390 px, accessibility issues from axe, and a pixel diff against the base commit; image paths plus a short summary that ends with what to do next. With no target, only components whose files changed are drawn ([render](#render)) |
| `youiyoux detect <repo-path>` | Which UI libraries a repo uses: package.json files, the lockfile, `components.json` (shadcn/ui; without one, a `components/ui` folder of shadcn files), shadcn's own `data-slot` names and the code's actual imports, through path aliases, relative paths and barrels. A package that is declared but never imported is listed under `unused`, never counted |
| `youiyoux detect <url…> [--expose]` | Which UI libraries a website uses, read in headless Chromium, with one element screenshot per element type. `--expose` opens menus, dialogs and tabs so portals render |

## Inventory

`youiyoux inventory --project ~/src/console --project ~/src/site` reads each directory as it is: no design repo and no `youi.project.json` needed (if one exists, only its `include`, `exclude`, `tsconfig` and `routes` are used; otherwise routes are detected from Expo Router, Next.js `app/**/page` and Astro `src/pages/` files). `--include <glob>` (repeatable) replaces each project's default or configured include globs, so a large repo can be limited without writing a config (`--include 'src/browser/**'`); stylesheets are always read, so the theme and class kits still resolve. `--exclude <glob>` (repeatable) adds to the exclude globs. It writes `youi.inventory/v1` to `.youi/inventory.json` in the first project (`--out` elsewhere) and prints roles by project, families, near-duplicates and flags.

| Finds | How |
| --- | --- |
| Definitions | Exported PascalCase React components (from `.tsx`/`.jsx`; a plain `.ts` export is not one), every `.astro` component, and each member of a class kit |
| Kits | A folder of components calling `cva()` (its base and `variants` tables are read), or a stylesheet's class kit: BEM blocks sharing a prefix (`.ui-button`, `.ui-button--sm`), and plain classes named for an element (`badge`, `pill`, `chip`, `tag`, `card`, `btn`, `button`, as the whole name or its first segment) whose rules set a shape (`.badge`) |
| Primitives | Library packages rendered or imported as components (Radix, lucide…), with their sites |
| Looks | Each rendered button, input, card, badge, dialog, tabs and link-as-button, from components and from styled native elements, with `file:line:column` and route |
| Recipes | Per look, how to draw it (optional in `youi.inventory/v1`): a React component's module, export, literal props (`variant="outline"`), label and the same module's components around it (Tabs > TabsList for a TabsTrigger, an open Dialog for its content), with its tag and classes as the fallback; anything else (class kits, Astro components, styled elements) a tag with its classes. `youiyoux inventory` only records them; the hub draws them |
| Stories | Storybook CSF 3 stories, read as authored states of their components ([below](#storybook-stories)) |

Roles come only from element and component names and ARIA roles (`<button>`, `role="tab"`, `*Badge`, `*Dialog`, a link inside `<Button asChild>`) and the kit member an element uses, never from utility class names. Each look's shape (height, horizontal and vertical padding, radius, font size, weight; colour ignored) is resolved from its classes: plain CSS rules first, then Tailwind utilities in order (a CVA base, its variants, the call site's `className`), including the CSS `font` shorthand's size, weight and line height, using the project's own theme (`@theme` and `:root` variables, a `tailwind.config.*` read statically and never run, `var()` and `calc()`, then Tailwind's defaults), so `rounded-md` is 8px where the project says so. A missing height is derived from padding, line height and border. Breakpoint and state classes (`md:`, `hover:`, `data-[state=active]:`) and pseudo-class or media rules are recorded on the look, not clustered; dynamic classes are listed as unresolved.

Looks are grouped per role, across all projects, with complete-link clustering: two looks share a family only if every dimension is within tolerance of every other look in it (height, padding and radius ±2px, font size ±1px, weight ±100; an unknown dimension matches only an unknown). When both looks have a fixed height (set, not derived), vertical padding is not compared: a 32px `.ui-button` with 6px vertical padding and a CVA `h-8` button with none are one shape. Single-link would chain a 28, 30, 32…38px ladder into one family; complete-link never does. A family that spans more than one project or kit is a near-duplicate. Flags: a component name defined in more than one file, and a file importing two kits' versions of one role (with each import statement and its line).

### Storybook stories

When a project has Storybook, `youiyoux inventory` reads its stories as extra specimens: each CSF 3 args story becomes a look of its meta's component with a `story` field (`title`, `name`, Storybook's `id`), drawn through the same specimen pipeline as any other look. Storybook is never installed, imported or run, and nothing needs it as a dependency.

- **Which files.** `.storybook/main.*`'s `stories` list (string globs, and `{ directory, files, titlePrefix }` entries) when it is plain values, else `**/*.stories.{tsx,ts,jsx,js,mjs}`; MDX docs are never read. Story files stay out of the normal walk, so a story's JSX never counts as a use.
- **What a story gives.** The default-export meta (an object, through `satisfies Meta`, `as Meta` or a named const) with `title` (else the file path, as Storybook titles it), `component`, `args` and `decorators`; each named export that is a CSF 3 object, with `args`, `name`, `render` and `decorators`. Meta args, then the story's (`...Primary.args` and `...Primary` are followed within the file). Literal args are props, a string `children` the label, `className` the call site's classes; anything else is listed as unresolved.
- **Decorators.** One that is only a chain of this project's components around `<Story />` with literal props (`<ThemeProvider theme="dark"><Story /></ThemeProvider>`) becomes the recipe's wrappers, meta's outside the story's. Any other (a package's provider, a `<div>` for padding, computed props) is left out and noted; the story is still drawn. `.storybook/preview.*` decorators are not applied, noted once.
- **Skipped, with a plain reason** and `file:line`: a CSF 2 function or `Template.bind` story, a story or meta with its own `render`, a meta that names no component, a component from a package rather than the project, a component that is not one the inventory groups, and a file that does not parse (also in the project's `failed` list). Nothing about a story stops the scan.
- **Families.** Families are clustered from real looks only. Each story then joins the family of its role it fits within tolerance of every shape in it, and the family gains `stories`; a story that fits none is grouped with the other leftover stories into a family marked `authored` (`looks: 0`), numbered after the real ones. A family's `looks`, sides, near-duplicate verdict, the summary's counts and the local index's `used-in` graph (`index_where_used`, `index_swap_impact`) count real uses only.
- **Output.** `youiyoux inventory` prints a Storybook section only when a project has stories (`Storybook: 12 stories in 5 files, 8 added as authored states beside their components; 5 skipped:`, then each `file:line Name — reason`, then what was left out) and a Next step; `--json` carries `projects[].stories` (`files`, `read`, `drawn`, `skipped`, `notes`). The hub labels each story tile `Storybook · <title> / <name>`.

## Detect

`youiyoux detect` writes a `youi.detect/v1` report (`--out <dir>`, default `.youi/detect/detect.json`, screenshots beside it): a verdict per library and per element type (button, input, dialog, menu, tabs, …), each with a confidence (high, medium, low) and the evidence behind it.

```sh
youiyoux detect ~/src/acme-app                                  # a repo
youiyoux detect https://acme.example/ https://acme.example/settings --expose   # a site, two pages
youiyoux ui --detect .youi/detect/detect.json                   # Library > Stack in the hub
```

**Coverage is per page crawled.** A website report covers only the URLs given, and says so: a library used only on another page, behind a sign-in, or in a menu nobody opened is not seen. Pass every page that matters, and `--expose` for portals.

Websites are read from these fingerprints, all in one pass per page: class prefixes (`Mui*`, `rt-*`, `sc-*`, `chakra-`, `mantine-`, `ant-`, `bp5-`), custom properties on `:root` (`--mui-`, `--radix-`, `--mantine-`, `--chakra-`, `--geist-`/`--ds-`), id prefixes (`base-ui-`, `radix-`, `headlessui-`), injected style tags (`data-styled`, `data-emotion`), shadcn/ui's own `data-slot` names, Radix Colors 12-step scales, Tailwind utility density and fonts. The table is `packages/detect/src/fingerprints.ts`.

- Only shadcn/ui's own slot names count: `data-slot="geist-icon"` is Geist's, and is noted as not counted. `--geist-` or `--ds-` variables alone give at most a low-confidence Geist verdict, never shadcn.
- Radix Colors scales and Tailwind density only support a verdict something else decided; on their own they never name a library.
- When two libraries match one element type (shadcn's dialog is a Radix dialog), the kit wins over the primitives it is built on; the other is listed as `also`.
- Website detection drives the headless-shell Chromium for the pinned `playwright-core`. The first website run downloads it (~100 MB, once) and says so; project setup never does. `YOUI_CHROMIUM=<path>` uses another Chromium instead.
- `pnpm test` runs the site tests (`packages/detect/test/site.test.ts`, real Chromium on the fixture pages) only when something under `packages/detect/` or `packages/core/src/detect` differs from origin/main, or git cannot tell; `YOUI_DETECT_SITE=1` always runs them (CI sets it), `YOUI_DETECT_SITE=0` never does.
- Not yet: ingesting whole library catalogs (that is Sources); grouping each rendered look by shape is [inventory](#inventory). In the hub, **Add to Library** drafts a `youi.library/v1` item from a detected element ("Seen on <site>, likely <library>") to copy or download; nothing is written.

## Render

`youiyoux render src/components/ui/button.tsx` (or the MCP tool `ui_render`, or a component name: `youiyoux render Button`) shows an agent the component it just changed. The PostToolUse hook (`youiyoux hooks install --claude`) adds one line after each edit of a `.tsx` or `.jsx` file saying so; it never renders inside the hook.

- **What is drawn.** The component's looks as the app renders them (inventory recipes: its props and labels at each site, up to 8 distinct looks; a component no site renders yet is drawn with no props), server-rendered with the project's own React and laid out on one page per scheme with the project's own CSS, exactly as specimens are. Inventoried source files contribute their Tailwind utilities even when automatic discovery ignores them (for example, gitignored vendored components); explicit `source(none)` remains explicit. A file that only uses components draws the looks it renders.
- **What comes back.** Four screenshots (light and dark at 1280 and 390 px); accessibility issues from [axe-core](https://github.com/dequelabs/axe-core) (WCAG 2.2 A and AA, on both schemes and widths), each with the element and the fix; and before, after and diff images against the base commit with the share of pixels that changed. The text ends with `next:` (fix these issues and render again; confirm the change is the one you meant; or nothing to do). `--json` gives the same with every path. Exit 1 only when nothing could be drawn (no Chromium, no such component), said plainly, never as a pass.
Accessibility findings are marked new, pre-existing or fixed against the base render (not-compared when no base is available). Expression name props receive deterministic example values (including matching id/title values on both renders); failed placeholder renders retry without them. Components whose recorded sites all share a parent render inside that parent, including across modules and one root helper. Accessible-name findings caused by props the specimen cannot supply (such as external aria-labelledby links) are marked `specimen-only: real usages pass …`; `next:` points only to new issues that are not specimen-only.

- **The base.** `--base <ref>`, else the merge base with `origin/main`, else `main`, else `HEAD`. Nothing is checked out: the files that differ are served to esbuild from `git show`, and their base contents are scanned by Tailwind for class names. Stylesheets come from the working tree on both sides (a changed stylesheet is noted). A new file has no before render, and outside git there is no base; both are said.
- **Fast.** Per component, the files its bundle read, its recipes, every stylesheet, the package versions and the base commit make a cache key; a hit returns the saved images with no bundle, no Tailwind and no browser. With no target, only components whose files differ from the base (or from their last render) are drawn, one Chromium for all of them; the rest are listed as unchanged. Base renders are kept per base commit. Images live under the specimen cache (`YOUI_SPECIMEN_CACHE`, else `~/.cache/youiyoux/specimens/shots`), never in the project.
- **Chromium.** The headless shell for the pinned `playwright-core`, as `youiyoux detect` uses: the first run downloads it (~100 MB, once) unless `YOUI_CHROMIUM` names another Chromium. The page fetches nothing from the network. The tests use the installed shell and never download it (`node node_modules/playwright-core/cli.js install chromium-headless-shell` in `packages/scanner` installs it).
- **Licence.** axe-core is MPL-2.0 (file-level copyleft), used unmodified as a dependency of `packages/scanner`; its files are not vendored or changed.

## The local index

Large, derived data lives in one store (`packages/store`): Discover listings, their signals and licences, every inventory run, and a graph of what uses what. Decisions (tokens, contracts, rules, adopted Library items, approvals) stay in git and are never kept there; everything in the store is rebuilt from files youi already writes.

- **Where.** A SQLite file through `node:sqlite` (Node 24): `YOUI_INDEX`, else beside an explicit `--cache`, else `$XDG_CACHE_HOME/youiyoux/index.db`. WAL, so the MCP server and the hub read while the CLI writes. With `DATABASE_URL` set, the same schema and queries run on Postgres instead (hosting it is not part of this repository). `youiyoux index path` prints which.
- **What fills it.** `youiyoux discover sync` loads the catalog (the store refreshes itself whenever `index.json` or `index-all.json` changes); `youiyoux inventory` records each run (project, commit, time, counts, families; looks for the newest run) and appends it to `scans.jsonl` beside the store; `youiyoux scan` records the project's rules and usage map. Search is FTS5 (porter unicode61, bm25) on SQLite and a stemmed `tsvector` on Postgres; it narrows the catalog, and Discover's own scorer ranks what is left, so both engines rank alike.
- **The graph.** `nodes(id, kind, ref)` and `edges(from, to, kind)`: family `used-in` file `used-in` route, family `near-duplicate-of` family, candidate `could-replace` family, rule `governs` component, project `uses-library` library; read with recursive CTEs that are the same SQL on both engines. The MCP tools `index_where_used`, `index_swap_impact` and `index_rule_covers` answer from it in about ten lines.
- **Rebuild.** Run `youiyoux index rebuild` to build a temporary database from the Discover cache, scan log, inventory files and scanned projects. SQLite checkpoints and closes it before an atomic rename; a failed build keeps the previous index available. Open readers detect the replacement and reopen. `youiyoux index stats` shows its generation. Deleted indexes can be rebuilt from the same sources.
- **Read-only queries.** Hub, MCP and CLI searches read the existing store without loading JSON or changing rows. Run `youiyoux discover sync` or `youiyoux index rebuild` to refresh it. Old schemas require a rebuild before read-only access.
- **Project scope.** Graph queries accept a project id; MCP defaults to the project at its configured root. Repeated family or rule ids return choices instead of choosing the newest scan. Near-duplicate edges stay within the selected project.
- **The hub.** `youiyoux ui`'s server answers paged queries at `GET /__youi/query?kind=discover|families|looks|history` for this machine only (any other `Host` is refused). The hub's pages still paint from the snapshot's JSON chunks and never ask it before they paint, except Discover, whose search is this query.
- **Discover in the hub.** The hub's Discover page (Library > Discover) searches these listings by need with facets (role, source, licence known or unknown, headless or styled), and fetches nothing for a candidate until a person opens it: then only that item's source, drawn in the project's own theme in a sandboxed frame, with what could not be themed said plainly. From an Inventory family, Find alternatives compares candidates beside it. Save to Library and Add to my project are drafts in the changes queue for a person to approve (`library/<source>/<name>.library.json` on a review branch); an item whose licence is unknown is never put up for adoption. Nothing is installed.
- **Measured** at 100,000 Library items and 5,000 looks: a Discover search on SQLite takes 40 ms at p95 (`YOUI_PERF=1 pnpm vitest run packages/store/test/store.perf.test.ts`; numbers in [apps/web/PERFORMANCE.md](../apps/web/PERFORMANCE.md#the-local-index-at-100000-library-items)).

## Migrations

A `youi.migration/v1` file lists changes for one element: `renameProp` and `mapValues` rewrite props at its call sites; `renameExport` and `removeExport` rewrite imports when the element's file renames or drops an export.

```yaml
schema: youi.migration/v1
id: youi:demo/migration/card-2.0.0
element: youi:demo/component/card
from: 1.x
to: 2.0.0
changes:
  - renameExport: { from: Card, to: Panel }
  - removeExport: { name: CardTitle, replacement: CardHeading }
  - removeExport: { name: CardContent }        # no replacement: reported, never rewritten
```

Run it after `youiyoux sync` has vendored the new file (the `exports` gate refuses before). Only names that resolve to the element's vendored file are touched, through barrels and aliases; lookalikes and vendored files never are. Rewritten: named, aliased, default and type-only imports (quotes, `type` and the other specifiers kept), re-exports in product barrels (`as default` too), uses of a local that had the old name (JSX, references, types) and namespace members (`ui.Card`). A file is left unchanged, and each of its sites listed with `file:line` and why, when the old local is re-declared, the new name is already used there, a namespace import is used dynamically, or an export is removed with no replacement. Props are then migrated on the rewritten sources.

Barrels keep their public names by default: `export { Card }` becomes `export { Panel as Card }`, so consumers of that barrel stay unchanged. The preview lists these preserved names. Set `renameExport: { from: Card, to: Panel, renameBarrels: true }` to rename the barrel's public name and its scanned consumers too. Removed exports with a replacement also keep barrel public names.

Quoted import names, namespace re-exports (`export * as ui`), and static import types (`typeof import("./ui").Card`) are supported. Runtime `import()` calls are reported for review because their uses cannot be traced safely. When a barrel is held for review, its dependent files are held too, including type-only consumers. The `imports-resolve` gate checks rewritten imports, re-exports, and namespace members against the resulting exports; an independent source and AST check catches old names left behind. Run `youiyoux migrate change.yaml` to preview the diff without writing. Only `--write`, with every gate passing, applies it.

## Guarantees

- **Identity, not names.** A `<Button>` counts only if its import resolves (TypeScript module resolution, through barrels and aliases) to the owned implementation. A same-named component from elsewhere is reported as a lookalike.
- **Unknown is never zero.** Sites the scanner cannot resolve are listed as unknown, and a scan with files it could not parse is marked `partial`.
- **Rewrites are gated.** A migration is written only if the rewritten files parse cleanly, the element's usage count is unchanged (plus the sites a renamed export makes resolvable again), no site became unknown, no non-residual site keeps the old API or an old export name, a second run changes nothing, and, for renamed or removed exports, the vendored file already exports the new names and the rewritten imports resolve.
- **Build with the System, browse the Library.** System elements (`youi:` ids) are approved: products and agents build only with them. Library items (`lib:` ids) are ingested references, kept to browse, categorize and propose as swaps; System lookups refuse them. An element moves `library → candidate → adopted → in-use`: an agent can only request adoption, a person approves it, and `in-use` is read off the usage map.
- **Agents propose, people approve.** Agents get read tools and a planner; nothing in the agent surface can publish a change.

## Roadmap (not built yet)

- **Library ingestion from links**: GitHub repos, Figma files, component catalogs, Storybook and DESIGN.md files, each categorized and reviewed before it lands in the Library.
- **Trial**: *Try alternatives* for an element, and *Try on a page* to see a candidate in a real screen before adopting it.
- **Replace with…**: swap one element for another across all of its uses, as a planned, reviewed change.
- **Screens, live**: screen snapshots with element positions, a live page view, and click-to-change on an element in place.
- **Hosted server**: on Railway, with logins, per-scope permissions, the Access page and a GitHub App; per-PR preview links for every change.
- **Public release prep**.
