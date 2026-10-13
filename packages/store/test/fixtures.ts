/** Small, hand-made inputs for the store contract: listings, two inventory runs and a project's rules and usage. */
import { InventoryReport, type RuleSpec } from "@youiyoux/core";
import type { DiscoverItem, DiscoverScope, SourceClass } from "../src/index.ts";

export function item(id: string, over: Partial<DiscoverItem> & { scope?: DiscoverScope; sourceClass?: SourceClass } = {}): DiscoverItem {
  const name = over.name ?? id.split("/").at(-1)!;
  return {
    id,
    scope: "chosen",
    ref: null,
    name,
    title: null,
    summary: `${name} component`,
    kind: "component",
    sourceKind: "shadcn-registry",
    sourceClass: "community",
    registry: "@coss",
    licence: "MIT",
    style: "styled",
    downloads: null,
    stars: null,
    archived: false,
    roles: [],
    searchText: `${name} ${over.summary ?? `${name} component`}`.toLowerCase(),
    entry: { id, name },
    builtAt: "2026-10-12T12:00:00.000Z",
    ...over,
  };
}

export const ITEMS: DiscoverItem[] = [
  item("lib:shadcn/component/command", { ref: "@shadcn/command", registry: "@shadcn", sourceClass: "official", summary: "Command menu built on cmdk", searchText: "command command menu built on cmdk cmdk", roles: ["command"] }),
  item("lib:coss/component/command", { ref: "@coss/command", summary: "A command palette", searchText: "command a command palette", roles: ["command"], licence: "unknown" }),
  item("lib:npm/component/cmdk", { ref: "cmdk", registry: "npm", sourceKind: "npm", sourceClass: "npm", style: "headless", downloads: 41_000_000, summary: "Fast, unstyled command menu", searchText: "cmdk fast unstyled command menu", roles: ["command"] }),
  item("lib:npm/component/sonner", { ref: "sonner", registry: "npm", sourceKind: "npm", sourceClass: "npm", downloads: 9_000_000, summary: "An opinionated toast component", searchText: "sonner an opinionated toast component", roles: ["toast"] }),
  item("lib:coss/component/dialog", { ref: "@coss/dialog", summary: "A modal dialog", searchText: "dialog a modal dialog", roles: ["dialog"], licence: "Apache-2.0" }),
  item("lib:kibo/component/dialog-stack", { ref: "@kibo/dialog-stack", registry: "@kibo", summary: "Stacked dialogs", searchText: "dialog stack stacked dialogs", roles: ["dialog"] }),
];

export const EXTRA_ALL: DiscoverItem[] = [item("lib:extra/component/command", { scope: "all", ref: "@extra/command", registry: "@extra", summary: "command palette", searchText: "command command palette", roles: ["command"] })];

const shape = (height: number | null, paddingX: number | null, radius: number | null) => ({ height, paddingX, paddingY: 0, radius, fontSize: 14, fontWeight: 500 });
const range = { height: null, paddingX: null, paddingY: null, radius: null, fontSize: null, fontWeight: null };

function look(project: string, file: string, line: number, family: string | null, routes: string[], role = "button", kit: string | null = `${project}:src/components/ui`) {
  return { id: `${project}:${file}:${line}:5`, project, file, line, column: 5, role, routes, routeSource: "route-file", source: "component", tag: "Button", definition: null, kit, shape: shape(36, 16, 8), derived: [], unresolved: [], responsive: [], states: [], family };
}

/** Two projects whose buttons are near-duplicates (different kits, a step apart). `extra` adds looks to show growth. */
export function inventory(generatedAt: string, extra = 0): InventoryReport {
  const looks = [
    look("console", "src/app/page.tsx", 10, "button-1", ["/"]),
    look("console", "src/app/settings/page.tsx", 20, "button-1", ["/settings"]),
    look("site", "src/pages/index.astro", 3, "button-2", ["/"], "button", "site:src/styles/ui.css"),
    look("console", "src/app/settings/page.tsx", 30, "dialog-1", ["/settings"], "dialog"),
    ...Array.from({ length: extra }, (_, i) => look("console", `src/app/extra-${i}.tsx`, 1, "button-1", [`/extra/${i}`])),
  ];
  const family = (id: string, role: string, s: ReturnType<typeof shape>, projects: string[], kits: string[]) => {
    const own = looks.filter((l) => l.family === id);
    const examples = own.slice(0, 3).map((l) => ({ project: l.project, file: l.file, line: l.line, column: l.column, tag: l.tag, routes: l.routes }));
    return { id, role, shape: s, range, looks: own.length, shapes: 1, projects, kits, examples, nearDuplicate: false, sides: [{ project: projects[0]!, kit: kits[0] ?? null, looks: own.length, examples }] };
  };
  return InventoryReport.parse({
    schema: "youi.inventory/v1",
    scanner: "test",
    generatedAt,
    durationMs: 1,
    tolerance: { height: 2, padding: 2, radius: 2, fontSize: 1, fontWeight: 100 },
    projects: [
      { id: "console", root: "fixtures/console", commit: "a".repeat(40), status: "complete", files: 4 + extra, routes: "next-app", failed: [], warnings: [] },
      { id: "site", root: "fixtures/site", commit: null, status: "complete", files: 1, routes: "astro", failed: [], warnings: [] },
    ],
    definitions: [],
    kits: [{ id: "console:src/components/ui", project: "console", kind: "cva-folder", path: "src/components/ui", members: [] }],
    primitives: [{ package: "@radix-ui/react-dialog", project: "console", exports: ["Dialog"], count: 1, sites: [] }],
    looks,
    families: [
      family("button-1", "button", shape(36, 16, 8), ["console"], ["console:src/components/ui"]),
      family("button-2", "button", shape(38, 18, 10), ["site"], ["site:src/styles/ui.css"]),
      family("dialog-1", "dialog", shape(null, 24, 10), ["console"], ["console:src/components/ui"]),
    ],
    flags: [],
    summary: { looks: looks.length, clustered: looks.length, unshaped: 0, notClustered: 0 },
  });
}

const rule = (id: string, check: RuleSpec["check"], statement: string): RuleSpec => ({ schema: "youi.rule/v1", id, title: id, severity: "warn", statement, rationale: "", agent: statement, check, files: ["**/*.tsx"], examples: { bad: [], good: [] } });

export const PROJECT = {
  project: "console",
  components: [
    { id: "youi:demo/component/button", name: "Button" },
    { id: "youi:demo/component/input", name: "Input" },
    { id: "youi:demo/component/card", name: "Card" },
  ],
  rules: [
    rule("youi:demo/rule/components.no-native-controls", { engine: "youi", id: "native-element", options: { elements: { button: "youi:demo/component/button", input: "youi:demo/component/input" } } }, "Render the owned controls."),
    rule("youi:demo/rule/components.one-primary-action", { engine: "advisory" }, "A view shows at most one default Button."),
    rule("youi:demo/rule/color.no-raw-color", { engine: "youi", id: "raw-color", options: {} }, "Use colour tokens."),
  ],
  usage: {
    usages: [
      { element: "youi:demo/component/button", file: "src/app/page.tsx", routes: ["/"] },
      { element: "youi:demo/component/button", file: "src/app/settings/page.tsx", routes: ["/settings"] },
      { element: "youi:demo/component/input", file: "src/app/login/page.tsx", routes: ["/login"] },
      { element: "youi:demo/component/card", file: "src/app/cards.tsx", routes: [] },
    ],
  },
} as const;
