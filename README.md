# YouIyouX

Tooling for a design language. Every token, component and rule has a stable id (`youi:<system>/<kind>/<name>`), a JSON contract, and a live map of where it is used in each product: file, line and screen. Every change is planned against those uses before it ships.

Phase 0 is local: the `youi` CLI, a scanner, a local MCP server and a web hub. No hosted service yet.

## The tool and the data live apart

This repository is the tool. It holds no product's design data: each design system lives in its own repository (a *design repo*), and `youi` reads it from a checkout, the way Terraform is a public tool that reads configuration it does not own.

| Lives | Where |
| --- | --- |
| The CLI, scanner, MCP server, hub and the published JSON Schemas | here |
| A system's tokens, component contracts and owned implementations, rules and narrative | its design repo |
| How a product uses a system (`youi.project.json`) | the product repo, or beside the system in its design repo (then `root` or `--root` names the product) |
| Scan results, permissions and approvals | the hosted database (not built yet); never in a repo |

A design repo is any directory with a `youi.config.json`. A product names it with `source.path` in its `youi.project.json` (relative to the config, or absolute), or any command takes `--design <dir>`. A design repo keeps the layout below; [`examples/demo-design`](examples/demo-design) is a complete one.

| Path in a design repo | Contents |
| --- | --- |
| `youi.config.json` | Systems and where their definitions live |
| `tokens/<system>/` | `youi.tokens/v1` tokens: DTCG 2025.10 plus two youi types, `spring` (stiffness, damping, mass, velocity) and `focusRing` (colour, width, offset, style); a resolver (base set plus a light/dark `theme` modifier). Values that reach CSS are kept from injecting declarations: token names and font family names hold only letters, digits, spaces (families) and hyphens |
| `components/<name>/` | `youi.component/v1` contracts (with optional `states`: hover, active, focus and disabled → role → token), the owned implementations that sync vendors into products, and an optional `<name>.demo.tsx` the hub previews |
| `rules/` | `youi.rule/v1` rules: prose for people, an instruction for agents, and an executable check |
| `library/` | `youi.library/v1` Library items (`library/<source>/<name>.library.json`): ingested references, never built with; none yet, sources come later |
| `systems/<system>/design.md` | The narrative; DESIGN.md is generated from it plus the tokens |
| `schema/` | Optional copies of this tool's JSON Schemas for editor validation (`youi schema --write --design .`; `--check` verifies them) |

## This repository

| Path | Contents |
| --- | --- |
| `packages/` | `core` (schemas, loader), `tokens` (Terrazzo build, import, parity), `scanner` (usage map, checks, migrations, plans), `detect` (which UI libraries a repo or website uses), `cli`, `mcp`, `workflow` (design-change service: rule and style drafts) |
| `apps/web/` | The hub: find an element, see its contract, tokens and rules, preview it, see where it lives ([README](apps/web/README.md)) |
| `schema/` | JSON Schemas, emitted from the Zod definitions in `packages/core` (`youi schema --write`) |
| `examples/demo-design/` | **Demo**, a made-up design system (Button, Input and Card; 29 tokens including motion, springs and a focus ring; states on Button and Input; 6 rules) used by the tests, these docs and the hub's default data |
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
| `youi plan` / `youi migrate` | Classify a change and its impact; run a gated codemod: a dry run that prints the diff and the residual sites unless `--write` ([migrations](#migrations)) |
| `youi library search <query>` / `youi library request <id> --reason …` | Browse the Library; draft a request to adopt an item into the System |
| `youi mcp` | stdio MCP server: `system_*` tools (build with these, plus `system_plan`) and `library_*` tools (browse, draft a request); no publish, approve or merge tools |
| `youi ui --project <dir>` | The hub on that product, with the local rule and style editors: drafts, impact preview against the project, approval, and a review branch in the design repo ([guide](packages/workflow/README.md)) |

`show`, `where`, `bom`, `check`, `plan` and `migrate` work on the System.

Every product command takes `--design <dir>` (override the design repo), `--config <file>` (a project config kept outside the product, for example in the design repo) and `--root <dir>` (the product root, when the config does not sit in it).

A config kept outside its product names the product's root:

| Setting | Where | Wins over |
| --- | --- | --- |
| `--root <dir>` | any product command | everything below |
| `"root"` in `youi.project.json` | relative to the config file, or absolute | `--project` |
| `--project <dir>` | where the config is looked for, and the root when nothing above is set | the current directory |

```sh
youi check --project ~/src/acme-design/pilot/acme-app --root ~/src/acme-app
```

If the root is not a directory, or none of its files match `include`, the command stops and names the root, the config and how to set `root`; it never reports 0 files as a pass. A real run on Toolroll is recorded in [docs/real-world-check.md](docs/real-world-check.md).

In a design repo (the current directory, or `--design <dir>`):

| Command | Does |
| --- | --- |
| `youi build` | Validate the token files with `youi.tokens/v1` and build the outputs (`--out`, `--prefix`): springs become a CSS `linear()` easing plus its settle duration, focus rings an outline shorthand plus offset, and contract states `--<prefix>-<component>-<state>-<role>` variables. Family names are written as escaped CSS strings and descriptions as comments that cannot be closed early |
| `youi parity --css <file>` | Compare the generated CSS with a product's shipped CSS, light and dark |
| `youi schema --check` | Check the repo's `schema/` copies against this tool's schemas (`--write` refreshes them) |

Anywhere:

| Command | Does |
| --- | --- |
| `youi inventory [--project <dir>…] [--include <glob>…] [--exclude <glob>…] [--out <file>] [--json]` | Every UI element across one or more projects, with no design system: definitions, kits, library primitives and each rendered look grouped into families by shape ([inventory](#inventory)) |
| `youi ui [--design <dir>] [--project <dir>] [--config <file>] [--root <dir>] [--inventory <file>] [--detect <file>]` | Start the hub on a design system (default: the demo); with `--project`, plus that product's usage map from a read-only scan; with `--inventory`, that inventory on the Inventory page; with `--detect`, a `youi detect` report on Library > Stack |
| `youi detect <repo-path>` | Which UI libraries a repo uses: package.json files, the lockfile, `components.json` (shadcn/ui; without one, a `components/ui` folder of shadcn files), shadcn's own `data-slot` names and the code's actual imports, through path aliases, relative paths and barrels. A package that is declared but never imported is listed under `unused`, never counted |
| `youi detect <url…> [--expose]` | Which UI libraries a website uses, read in headless Chromium, with one element screenshot per element type. `--expose` opens menus, dialogs and tabs so portals render |

## Inventory

`youi inventory --project ~/src/console --project ~/src/site` reads each directory as it is: no design repo and no `youi.project.json` needed (if one exists, only its `include`, `exclude`, `tsconfig` and `routes` are used; otherwise routes are detected from Expo Router, Next.js `app/**/page` and Astro `src/pages/` files). `--include <glob>` (repeatable) replaces each project's default or configured include globs, so a large repo can be limited without writing a config (`--include 'src/browser/**'`); stylesheets are always read, so the theme and class kits still resolve. `--exclude <glob>` (repeatable) adds to the exclude globs. It writes `youi.inventory/v1` to `.youi/inventory.json` in the first project (`--out` elsewhere) and prints roles by project, families, near-duplicates and flags.

| Finds | How |
| --- | --- |
| Definitions | Exported PascalCase React components (from `.tsx`/`.jsx`; a plain `.ts` export is not one), every `.astro` component, and each member of a class kit |
| Kits | A folder of components calling `cva()` (its base and `variants` tables are read), or a stylesheet's class kit: BEM blocks sharing a prefix (`.ui-button`, `.ui-button--sm`), and plain classes named for an element (`badge`, `pill`, `chip`, `tag`, `card`, `btn`, `button`, as the whole name or its first segment) whose rules set a shape (`.badge`) |
| Primitives | Library packages rendered or imported as components (Radix, lucide…), with their sites |
| Looks | Each rendered button, input, card, badge, dialog, tabs and link-as-button, from components and from styled native elements, with `file:line:column` and route |
| Recipes | Per look, how to draw it (optional in `youi.inventory/v1`): a React component's module, export, literal props (`variant="outline"`), label and the same module's components around it (Tabs > TabsList for a TabsTrigger, an open Dialog for its content), with its tag and classes as the fallback; anything else (class kits, Astro components, styled elements) a tag with its classes. `youi inventory` only records them; the hub draws them |

Roles come only from element and component names and ARIA roles (`<button>`, `role="tab"`, `*Badge`, `*Dialog`, a link inside `<Button asChild>`) and the kit member an element uses, never from utility class names. Each look's shape (height, horizontal and vertical padding, radius, font size, weight; colour ignored) is resolved from its classes: plain CSS rules first, then Tailwind utilities in order (a CVA base, its variants, the call site's `className`), including the CSS `font` shorthand's size, weight and line height, using the project's own theme (`@theme` and `:root` variables, a `tailwind.config.*` read statically and never run, `var()` and `calc()`, then Tailwind's defaults), so `rounded-md` is 8px where the project says so. A missing height is derived from padding, line height and border. Breakpoint and state classes (`md:`, `hover:`, `data-[state=active]:`) and pseudo-class or media rules are recorded on the look, not clustered; dynamic classes are listed as unresolved.

Looks are grouped per role, across all projects, with complete-link clustering: two looks share a family only if every dimension is within tolerance of every other look in it (height, padding and radius ±2px, font size ±1px, weight ±100; an unknown dimension matches only an unknown). When both looks have a fixed height (set, not derived), vertical padding is not compared: a 32px `.ui-button` with 6px vertical padding and a CVA `h-8` button with none are one shape. Single-link would chain a 28, 30, 32…38px ladder into one family; complete-link never does. A family that spans more than one project or kit is a near-duplicate. Flags: a component name defined in more than one file, and a file importing two kits' versions of one role (with each import statement and its line).

## Detect

`youi detect` writes a `youi.detect/v1` report (`--out <dir>`, default `.youi/detect/detect.json`, screenshots beside it): a verdict per library and per element type (button, input, dialog, menu, tabs, …), each with a confidence (high, medium, low) and the evidence behind it.

```sh
youi detect ~/src/acme-app                                  # a repo
youi detect https://acme.example/ https://acme.example/settings --expose   # a site, two pages
youi ui --detect .youi/detect/detect.json                   # Library > Stack in the hub
```

**Coverage is per page crawled.** A website report covers only the URLs given, and says so: a library used only on another page, behind a sign-in, or in a menu nobody opened is not seen. Pass every page that matters, and `--expose` for portals.

Websites are read from these fingerprints, all in one pass per page: class prefixes (`Mui*`, `rt-*`, `sc-*`, `chakra-`, `mantine-`, `ant-`, `bp5-`), custom properties on `:root` (`--mui-`, `--radix-`, `--mantine-`, `--chakra-`, `--geist-`/`--ds-`), id prefixes (`base-ui-`, `radix-`, `headlessui-`), injected style tags (`data-styled`, `data-emotion`), shadcn/ui's own `data-slot` names, Radix Colors 12-step scales, Tailwind utility density and fonts. The table is `packages/detect/src/fingerprints.ts`.

- Only shadcn/ui's own slot names count: `data-slot="geist-icon"` is Geist's, and is noted as not counted. `--geist-` or `--ds-` variables alone give at most a low-confidence Geist verdict, never shadcn.
- Radix Colors scales and Tailwind density only support a verdict something else decided; on their own they never name a library.
- When two libraries match one element type (shadcn's dialog is a Radix dialog), the kit wins over the primitives it is built on; the other is listed as `also`.
- Website detection drives the headless-shell Chromium for the pinned `playwright-core`. The first website run downloads it (~100 MB, once) and says so; project setup never does. `YOUI_CHROMIUM=<path>` uses another Chromium instead.
- `pnpm test` runs the site tests (`packages/detect/test/site.test.ts`, real Chromium on the fixture pages) only when something under `packages/detect/` or `packages/core/src/detect` differs from origin/main, or git cannot tell; `YOUI_DETECT_SITE=1` always runs them (CI sets it), `YOUI_DETECT_SITE=0` never does.
- Not yet: ingesting whole library catalogs (that is Sources); grouping each rendered look by shape is [inventory](#inventory). In the hub, **Add to Library** drafts a `youi.library/v1` item from a detected element ("Seen on <site>, likely <library>") to copy or download; nothing is written.

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

Run it after `youi sync` has vendored the new file (the `exports` gate refuses before). Only names that resolve to the element's vendored file are touched, through barrels and aliases; lookalikes and vendored files never are. Rewritten: named, aliased, default and type-only imports (quotes, `type` and the other specifiers kept), re-exports in product barrels (`as default` too), uses of a local that had the old name (JSX, references, types) and namespace members (`ui.Card`). A file is left unchanged, and each of its sites listed with `file:line` and why, when the old local is re-declared, the new name is already used there, a namespace import is used dynamically, or an export is removed with no replacement. Props are then migrated on the rewritten sources.

Barrels keep their public names by default: `export { Card }` becomes `export { Panel as Card }`, so consumers of that barrel stay unchanged. The preview lists these preserved names. Set `renameExport: { from: Card, to: Panel, renameBarrels: true }` to rename the barrel's public name and its scanned consumers too. Removed exports with a replacement also keep barrel public names.

Quoted import names, namespace re-exports (`export * as ui`), and static import types (`typeof import("./ui").Card`) are supported. Runtime `import()` calls are reported for review because their uses cannot be traced safely. When a barrel is held for review, its dependent files are held too, including type-only consumers. The `imports-resolve` gate checks rewritten imports, re-exports, and namespace members against the resulting exports; an independent source and AST check catches old names left behind. Run `youi migrate change.yaml` to preview the diff without writing. Only `--write`, with every gate passing, applies it.

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

## License

None chosen yet; see [LICENSE](LICENSE). The repository is private.
