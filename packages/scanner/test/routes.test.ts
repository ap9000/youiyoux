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
  test("the unchanged demo records every scanned file and gives each finding its file's routes", async () => {
    const { report, files } = await scanProject(await loadProject(DEMO));
    expect(Object.keys(report.fileRoutes!)).toEqual(files);
    expect(report.fileRoutes?.["components/invite-form.tsx"]).toEqual({ routes: ["/invite"], routeSource: "imported-by", via: "app/invite/index.tsx" });
    for (const finding of findings(report)) expect(finding).toMatchObject(report.fileRoutes![finding.file]!);
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
      for (const finding of found) expect(finding).toMatchObject(report.fileRoutes![ISSUES]!);
    }
    expect(report.violations.find((v) => v.file === CSS)?.routes).toEqual(routes);
    expect(Object.keys(report.fileRoutes!)).toEqual(files);
    expect(ScanReport.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  test("unreachable files and type-only imports keep a reason, including every kind of finding", async () => {
    const { report } = await scanProject(project);
    for (const file of [ORPHAN, TYPES]) {
      const attribution = { routes: [], routeSource: "unrouted", routeReason: "No route or app shell reaches this file through scanned imports." };
      expect(report.fileRoutes?.[file]).toEqual(attribution);
      for (const list of [report.violations, report.lookalikes, report.unknowns]) {
        const found = list.filter((f) => f.file === file);
        expect(found.length).toBeGreaterThan(0);
        for (const finding of found) expect(finding).toMatchObject(attribution);
      }
    }
  });

  test("a screen importing another route reaches that file and its findings too", async () => {
    const mapped = withRoutes({ strategy: "map", map: [
      { file: "app/invite/index.tsx", routes: ["/join"] },
      { file: "app/settings/index.tsx", routes: ["/preferences"] },
    ] });
    const { report } = await scanProject(mapped, { overrides: {
      "app/settings/index.tsx": 'export { default } from "../invite";',
      "app/invite/index.tsx": 'export default function Invite() { return <button>Invite</button>; }',
    } });
    expect(report.fileRoutes?.["app/invite/index.tsx"]).toEqual({ routes: ["/join", "/preferences"], routeSource: "route-file" });
    expect(report.violations.find((v) => v.file === "app/invite/index.tsx")?.routes).toEqual(["/join", "/preferences"]);
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
    for (const finding of findings(disabled)) expect(finding).toMatchObject({ routes: [], routeSource: "unrouted", routeReason: "Route mapping is disabled in the project config." });
    const shell = (await scanProject(withRoutes({ strategy: "none", shell: ["app/_layout.tsx"] }))).report;
    expect(shell.fileRoutes?.[SHELL]).toMatchObject({ routes: ["*"], routeSource: "shell" });
    const focused = (await scanProject(project, { focus: [ISSUES] })).report;
    expect(Object.keys(focused.fileRoutes!)).toEqual([ISSUES]);
    for (const finding of findings(focused)) expect(finding).toMatchObject({ routes: [], routeSource: "unrouted", routeReason: expect.stringContaining("focused scan") });
  });

  test("cached scans recalculate routes when an import or the route config changes", async () => {
    const cache = new ScanCache();
    const first = await scanProject(project, { cache });
    expect((await scanProject(project, { cache })).report.fileRoutes).toEqual(first.report.fileRoutes);
    const edited = await scanProject(project, { cache, overrides: { "app/settings/index.tsx": "export default function Settings() { return <p>Settings</p>; }" } });
    expect(edited.report.fileRoutes?.[ISSUES]?.routes).toEqual(["/invite"]);
    const mapped = await scanProject(withRoutes({ strategy: "map", map: [{ file: "app/invite/index.tsx", routes: ["/join"] }] }), { cache });
    expect(mapped.report.fileRoutes?.[ISSUES]?.routes).toEqual(["/join"]);
    for (const finding of findings(mapped.report).filter((f) => f.file === ISSUES)) expect(finding.routes).toEqual(["/join"]);
  });
});
