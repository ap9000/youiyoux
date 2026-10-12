import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RouteConfig, ScanReport } from "@youiyoux/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadProject, ScanCache, scanProject, type Project } from "../src/index.ts";

const REPO = join(import.meta.dirname, "../../..");
const DEMO = join(REPO, "examples/demo-app");
const ISSUES = "components/route-fixtures/issues.tsx";
const ORPHAN = "components/route-fixtures/orphan.tsx";
const TYPES = "components/route-fixtures/types.tsx";
const CSS = "components/route-fixtures/styles.css";
const SHELL = "components/route-fixtures/shell.tsx";
const issues = `import { Button } from "other-kit";
import { Missing } from "./missing";
export function Issues() { return <div><button>Native</button><Button /><Missing /></div>; }
`;

let root: string;
let project: Project;
beforeAll(async () => {
  // Extend a scratch copy of the real demo; its shipped UI and deliberate issue counts stay intact.
  const scratch = join(REPO, ".dl/cache");
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "demo-routes-"));
  await cp(DEMO, root, { recursive: true });
  await mkdir(join(root, "components/route-fixtures"));
  const files: Record<string, string> = {
    [ISSUES]: issues,
    [ORPHAN]: issues,
    [TYPES]: `${issues}\nexport type Only = string;`,
    [CSS]: ".notice { color: #c62828; }",
    "components/route-fixtures/entry.css": "",
    "app/invite/_layout.tsx": "export default function Layout() { return null; }",
    [SHELL]: "export function ShellNotice() { return <button>Notice</button>; }",
    "components/route-fixtures/index.ts": 'export * from "./cycle"; export { Issues } from "./issues"; export type * from "./types";',
    "components/route-fixtures/cycle.ts": 'export * from "./index"; export { type Only } from "./types";',
    "app/invite/index.tsx": 'import { Issues } from "@/components/route-fixtures"; import "@/components/route-fixtures/styles.css"; import type { Only } from "@/components/route-fixtures/types"; export default function Invite() { return <Issues />; }',
    "app/settings/index.tsx": 'import { Issues } from "@/components/route-fixtures"; import "../../components/route-fixtures/styles.css"; export default function Settings() { return <Issues />; }',
  };
  await Promise.all(Object.entries(files).map(([file, text]) => writeFile(join(root, file), text)));
  const layout = join(root, "app/_layout.tsx");
  await writeFile(layout, `import "@/components/route-fixtures/shell";\n${await readFile(layout, "utf8")}`);
  const loaded = await loadProject(root, { designRoot: join(REPO, "examples/demo-design") });
  project = { ...loaded, config: { ...loaded.config, include: [...loaded.config.include, "components/**/*.css"] } };
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const withRoutes = (routes: unknown): Project => ({ ...project, config: { ...project.config, routes: RouteConfig.parse(routes) } });
const findings = (report: ScanReport) => [...report.violations, ...report.lookalikes, ...report.unknowns];

describe("demo-app file routes", () => {
  test("the unchanged demo records every scanned file and keeps finding routes only in fileRoutes", async () => {
    const { report, files } = await scanProject(await loadProject(DEMO));
    expect(Object.keys(report.fileRoutes!)).toEqual(files);
    expect(report.fileRoutes?.["components/invite-form.tsx"]).toEqual({ routes: ["/invite"], routeSource: "imported-by", via: "app/invite/index.tsx" });
    for (const finding of findings(report)) {
      expect(report.fileRoutes).toHaveProperty(finding.file);
      for (const key of ["routes", "routeSource", "via", "routeReason"]) expect(finding).not.toHaveProperty(key);
    }
    const legacy = {
      ...report,
      violations: report.violations.map((f) => ({ ...f, ...report.fileRoutes![f.file] })),
      lookalikes: report.lookalikes.map((f) => ({ ...f, ...report.fileRoutes![f.file] })),
      unknowns: report.unknowns.map((f) => ({ ...f, ...report.fileRoutes![f.file] })),
    };
    expect(ScanReport.parse(legacy)).toEqual(report);
    expect(ScanReport.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  test.each(["map", "expo-router"] as const)("%s routes reach findings without element sites, through aliases, barrels and cycles", async (strategy) => {
    const mapped = withRoutes({ strategy, map: [
      { file: "app/invite/*.tsx", routes: ["/join", "/join"], evidence: "Invite route" },
      { file: "app/settings/index.tsx", routes: ["/preferences"] },
      { file: "app/invite/index.tsx", routes: ["/join"] },
    ] });
    const { report, files } = await scanProject(mapped);
    const routes = strategy === "map" ? ["/join", "/preferences"] : ["/invite", "/settings"];
    expect(report.usages.filter((u) => u.file === ISSUES || u.file === CSS)).toEqual([]);
    expect(report.fileRoutes?.[ISSUES]).toEqual({ routes, routeSource: "imported-by", via: "app/invite/index.tsx" });
    expect(report.fileRoutes?.[CSS]?.routes).toEqual(routes);
    for (const list of [report.violations, report.lookalikes, report.unknowns]) {
      const found = list.filter((f) => f.file === ISSUES);
      expect(found.length).toBeGreaterThan(0);
      for (const finding of found) expect(report.fileRoutes![finding.file]?.routes).toEqual(routes);
    }
    expect(report.violations.some((v) => v.file === CSS)).toBe(true);
    expect(Object.keys(report.fileRoutes!)).toEqual(files);
    expect(ScanReport.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  test("unreachable files and type-only imports keep a reason and a fix", async () => {
    const { report } = await scanProject(project);
    expect(report.fileRoutes?.[ORPHAN]).toMatchObject({ routes: [], routeSource: "unrouted", routeReason: expect.stringContaining("No scanned file imports") });
    expect(report.fileRoutes?.[ORPHAN]?.routeReason).toContain("routes.map or routes.shell");
    expect(report.fileRoutes?.[TYPES]).toMatchObject({ routes: [], routeSource: "unrouted", routeReason: expect.stringContaining("Only type imports") });
    for (const file of [ORPHAN, TYPES]) {
      for (const list of [report.violations, report.lookalikes, report.unknowns]) {
        expect(list.some((f) => f.file === file)).toBe(true);
      }
    }
  });

  test("an orphan stylesheet suggests routes.shell and an unrouted import names its importer", async () => {
    const mapped = withRoutes({ strategy: "map", map: [{ file: "app/index.tsx", routes: ["/"] }] });
    const { report } = await scanProject(mapped, { overrides: {
      [SHELL]: 'export const load = () => import("./orphan");',
      "components/route-fixtures/entry.css": ".notice { color: #c62828; }",
    } });
    expect(report.fileRoutes?.[ORPHAN]?.routeReason).toContain(`Only files not on any screen import this file, including ${SHELL}`);
    expect(report.fileRoutes?.[ORPHAN]?.routeReason).toContain("routes.map or routes.shell");
    expect(report.fileRoutes?.["components/route-fixtures/entry.css"]?.routeReason).toContain("No scanned file imports");
    expect(report.fileRoutes?.["components/route-fixtures/entry.css"]?.routeReason).toContain("routes.shell in youi.project.json");
  });

  test("a type-only star re-export explains why its file has no route", async () => {
    const { report } = await scanProject(project, { overrides: {
      "components/route-fixtures/index.ts": 'export type * from "./orphan";',
    } });
    expect(report.fileRoutes?.[ORPHAN]).toMatchObject({ routes: [], routeSource: "unrouted", routeReason: expect.stringContaining("Only type imports") });
  });

  test("a screen borrowing a helper from another route does not reach that file or its imports", async () => {
    const mapped = withRoutes({ strategy: "map", map: [
      { file: "app/invite/index.tsx", routes: ["/join"] },
      { file: "app/settings/index.tsx", routes: ["/preferences"] },
    ] });
    const { report } = await scanProject(mapped, { overrides: {
      "app/settings/index.tsx": 'import { helper } from "../invite"; export default function Settings() { return <p>{helper()}</p>; }',
      "app/invite/index.tsx": 'import { Issues } from "@/components/route-fixtures/issues"; export const helper = () => "hello"; export default function Invite() { return <div><button>Invite</button><Issues /></div>; }',
    } });
    expect(report.fileRoutes?.["app/invite/index.tsx"]?.routes).toEqual(["/join"]);
    expect(report.fileRoutes?.[ISSUES]?.routes).toEqual(["/join"]);
    expect(report.violations.some((v) => v.file === "app/invite/index.tsx")).toBe(true);
    expect(findings(report).some((f) => f.file === ISSUES)).toBe(true);
  });

  test.each([
    'export { default } from "../invite";',
    'import Invite from "../invite"; export default Invite;',
  ])("a route forwarding a default component reaches its target and imports: %s", async (source) => {
    const mapped = withRoutes({ strategy: "map", map: [
      { file: "app/invite/index.tsx", routes: ["/join"] },
      { file: "app/settings/index.tsx", routes: ["/preferences"] },
    ] });
    const { report } = await scanProject(mapped, { overrides: {
      "app/settings/index.tsx": source,
      "app/invite/index.tsx": 'import { Issues } from "@/components/route-fixtures/issues"; export default function Invite() { return <div><button>Invite</button><Issues /></div>; }',
    } });
    expect(report.fileRoutes?.["app/invite/index.tsx"]).toEqual({ routes: ["/join", "/preferences"], routeSource: "route-file" });
    expect(report.fileRoutes?.[ISSUES]?.routes).toEqual(["/join", "/preferences"]);
  });

  test("a blocked edge does not hide a later default re-export edge to the same route", async () => {
    const mapped = withRoutes({ strategy: "map", map: [
      { file: "app/invite/index.tsx", routes: ["/join"] },
      { file: "app/settings/index.tsx", routes: ["/preferences"] },
    ] });
    const { report } = await scanProject(mapped, { overrides: {
      "app/settings/index.tsx": 'export { default } from "@/components/route-fixtures/cycle"; import "../invite";',
      "components/route-fixtures/cycle.ts": 'export { default } from "../../app/invite";',
    } });
    expect(report.fileRoutes?.[ISSUES]?.routes).toEqual(["/join", "/preferences"]);
  });

  test.each([
    'export const load = () => import("@/components/route-fixtures/orphan");',
    'export const load = () => import("@/components/route-fixtures/orphan", { with: { type: "json" } });',
    'import { lazy } from "react"; export default lazy(() => import("@/components/route-fixtures/orphan"));',
    'export const load = () => require("@/components/route-fixtures/orphan");',
  ])("literal calls reach findings without system elements: %s", async (source) => {
    const mapped = withRoutes({ strategy: "map", map: [{ file: "app/invite/index.tsx", routes: ["/join"] }] });
    const { report } = await scanProject(mapped, { overrides: { "app/invite/index.tsx": source } });
    expect(report.fileRoutes?.[ORPHAN]?.routes).toEqual(["/join"]);
    expect(report.usages.filter((u) => u.file === ORPHAN)).toEqual([]);
    for (const list of [report.violations, report.lookalikes, report.unknowns]) {
      expect(list.some((f) => f.file === ORPHAN)).toBe(true);
    }
  });

  test.each(['"./styles.css"', 'url("./styles.css")', "url('./styles.css')", 'url(./styles.css)', '"styles.css"'])("CSS @import %s reaches stylesheet findings", async (specifier) => {
    const { report } = await scanProject(withRoutes({ strategy: "map", shell: [SHELL] }), { overrides: {
      [SHELL]: 'import "./entry.css";',
      "components/route-fixtures/entry.css": `@import ${specifier};`,
      [CSS]: '@import "./entry.css"; .notice { color: #c62828; }',
    } });
    expect(report.fileRoutes?.[CSS]?.routes).toEqual(["*"]);
    expect(report.violations.some((v) => v.file === CSS)).toBe(true);
  });

  test("computed calls, member calls, packages and commented CSS imports do not guess a route", async () => {
    const { report } = await scanProject(withRoutes({ strategy: "map", shell: [SHELL] }), { overrides: {
      [SHELL]: 'const path = "./orphan"; import(path); require(path); loader.require("./orphan"); import("other-kit"); import "./entry.css";',
      "components/route-fixtures/entry.css": `/* @import "./styles.css"; */ .notice::before { content: '@import "./styles.css";'; }`,
    } });
    expect(report.fileRoutes?.[ORPHAN]?.routes).toEqual([]);
    expect(report.fileRoutes?.[CSS]?.routes).toEqual([]);
  });

  test("a shell stops at another shell entry, preserving nested Expo layout routes", async () => {
    const { report } = await scanProject(project, { overrides: {
      "app/_layout.tsx": 'import "./invite/_layout"; export default function Root() { return null; }',
      "app/invite/_layout.tsx": 'import "@/components/route-fixtures/shell"; export default function Layout() { return null; }',
    } });
    expect(report.fileRoutes?.["app/invite/_layout.tsx"]?.routes).toEqual(["/invite"]);
    expect(report.fileRoutes?.[SHELL]).toMatchObject({ routes: ["/invite"], routeSource: "shell" });
  });

  test("editing a literal dynamic dependency invalidates its importer's cached analysis", async () => {
    const cache = new ScanCache();
    const overrides = { "app/invite/index.tsx": 'export const load = () => import("@/components/route-fixtures/orphan");' };
    const first = await scanProject(project, { cache, overrides });
    const same = await scanProject(project, { cache, overrides });
    expect(same.analyses.get("app/invite/index.tsx")).toBe(first.analyses.get("app/invite/index.tsx"));
    const edited = await scanProject(project, { cache, overrides: { ...overrides, [ORPHAN]: `${issues}\n// edited` } });
    expect(edited.analyses.get("app/invite/index.tsx")).not.toBe(first.analyses.get("app/invite/index.tsx"));
    expect(edited.analyses.get("app/settings/index.tsx")).toBe(first.analyses.get("app/settings/index.tsx"));
    expect(edited.report.fileRoutes?.[ORPHAN]?.routes).toEqual(["/invite"]);
  });

  test("parse failures keep known routes, and excluded imports are not traversed", async () => {
    const partial = await scanProject(project, { overrides: { [ISSUES]: `${issues}\nexport function broken( {` } });
    expect(partial.report.status).toBe("partial");
    expect(partial.report.coverage.failed.some((f) => f.file === ISSUES)).toBe(true);
    expect(partial.report.fileRoutes?.[ISSUES]?.routes).toEqual(["/invite", "/settings"]);
    const excluded = await scanProject({ ...project, config: { ...project.config, exclude: ["components/route-fixtures/index.ts"] } });
    expect(excluded.report.fileRoutes?.[ISSUES]).toMatchObject({ routes: [], routeSource: "unrouted", routeReason: expect.any(String) });
    expect(excluded.report.fileRoutes).not.toHaveProperty("components/route-fixtures/index.ts");
  });

  test("Expo layouts and explicit shells attribute their imports, without spreading shell routes into screens", async () => {
    const expo = (await scanProject(project)).report;
    expect(expo.fileRoutes?.[SHELL]).toMatchObject({ routes: ["/", "/invite", "/settings"], routeSource: "shell" });
    const mapped = withRoutes({ strategy: "map", map: [{ file: "app/invite/index.tsx", routes: ["/join"] }], shell: ["app/_layout.tsx"] });
    const layout = await readFile(join(root, "app/_layout.tsx"), "utf8");
    const { report } = await scanProject(mapped, { overrides: { "app/_layout.tsx": `${layout}\nimport "./invite";` } });
    expect(report.fileRoutes?.[SHELL]).toMatchObject({ routes: ["*"], routeSource: "shell" });
    expect(report.fileRoutes?.[ISSUES]?.routes).toEqual(["/join"]);
  });

  test("none and focused scans explain why routes are absent; explicit shells still work with none", async () => {
    const disabled = (await scanProject(withRoutes({ strategy: "none" }))).report;
    for (const finding of findings(disabled)) expect(disabled.fileRoutes![finding.file]).toMatchObject({ routes: [], routeSource: "unrouted", routeReason: "Route mapping is disabled in the project config." });
    const shell = (await scanProject(withRoutes({ strategy: "none", shell: ["app/_layout.tsx"] }))).report;
    expect(shell.fileRoutes?.[SHELL]).toMatchObject({ routes: ["*"], routeSource: "shell" });
    const focused = (await scanProject(project, { focus: [ISSUES] })).report;
    expect(Object.keys(focused.fileRoutes!)).toEqual([ISSUES]);
    for (const finding of findings(focused)) expect(focused.fileRoutes![finding.file]).toMatchObject({ routes: [], routeSource: "unrouted", routeReason: expect.stringContaining("focused scan") });
  });

  test("cached scans recalculate routes when an import or the route config changes", async () => {
    const cache = new ScanCache();
    const first = await scanProject(project, { cache });
    expect((await scanProject(project, { cache })).report.fileRoutes).toEqual(first.report.fileRoutes);
    const edited = await scanProject(project, { cache, overrides: { "app/settings/index.tsx": "export default function Settings() { return <p>Settings</p>; }" } });
    expect(edited.report.fileRoutes?.[ISSUES]?.routes).toEqual(["/invite"]);
    const mapped = await scanProject(withRoutes({ strategy: "map", map: [{ file: "app/invite/index.tsx", routes: ["/join"] }] }), { cache });
    expect(mapped.report.fileRoutes?.[ISSUES]?.routes).toEqual(["/join"]);
    for (const finding of findings(mapped.report).filter((f) => f.file === ISSUES)) expect(mapped.report.fileRoutes![finding.file]?.routes).toEqual(["/join"]);
  });

  test("100 routes and 300 finding files store routes once per file within the size budget", async () => {
    const largeRoot = await mkdtemp(join(REPO, ".dl/cache/many-routes-"));
    try {
      await cp(DEMO, largeRoot, { recursive: true });
      await mkdir(join(largeRoot, "scale/components"), { recursive: true });
      const numbers = (count: number) => Array.from({ length: count }, (_, i) => String(i).padStart(3, "0"));
      const components = numbers(300).map((n) => `scale/components/issue-${n}.tsx`);
      const routes = numbers(100).map((n) => `/scale/${n}`);
      const files = {
        ...Object.fromEntries(components.map((file) => [file, issues])),
        ...Object.fromEntries(numbers(100).map((n) => [`scale/route-${n}.tsx`, 'import "./index";'])),
        "scale/index.ts": numbers(300).map((n) => `export { Issues as Issue${n} } from "./components/issue-${n}";`).join("\n"),
      };
      await Promise.all(Object.entries(files).map(([file, source]) => writeFile(join(largeRoot, file), source)));
      const loaded = await loadProject(largeRoot, { designRoot: join(REPO, "examples/demo-design") });
      const mapped = { ...loaded, config: { ...loaded.config, include: ["scale/**/*.{ts,tsx}"], routes: RouteConfig.parse({
        strategy: "map", map: numbers(100).map((n) => ({ file: `scale/route-${n}.tsx`, routes: [`/scale/${n}`] })),
      }) } };
      const { report } = await scanProject(mapped);
      expect(report.status).toBe("complete");
      expect(report.usages).toEqual([]);
      // Each file breaks both the native-control and canonical-import rules.
      expect(report.violations).toHaveLength(600);
      for (const rule of ["components.no-native-controls", "components.canonical-import"]) {
        expect(report.violations.filter((v) => v.rule === `youi:demo/rule/${rule}`)).toHaveLength(300);
      }
      expect(report.lookalikes).toHaveLength(300);
      expect(report.unknowns).toHaveLength(300);
      for (const file of components) expect(report.fileRoutes?.[file]?.routes).toEqual(routes);
      for (const finding of findings(report)) {
        for (const key of ["routes", "routeSource", "via", "routeReason"]) expect(finding).not.toHaveProperty(key);
      }
      const serialized = JSON.stringify(report);
      expect(serialized.match(/"routes":/g)).toHaveLength(Object.keys(files).length);
      // Measured at ~696 KB for 100 routes and 1,200 findings. A 1 MB budget
      // leaves roughly 1.5x headroom, but fails if findings duplicate route lists.
      expect(Buffer.byteLength(serialized)).toBeLessThan(1_000_000);
    } finally {
      await rm(largeRoot, { recursive: true, force: true });
    }
  });
});
