import { join } from "node:path";
import { normalizeProjectConfig, ScanReport } from "@youiyoux/core";
import { beforeAll, describe, expect, test } from "vitest";
import { expoRoute, loadProject, scanProject, type ScanResult } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/expo-app");
const BUTTON = "youi:signal/component/button";

let result: ScanResult;
beforeAll(async () => {
  result = await scanProject(await loadProject(FIXTURE));
});

const sites = (element: string) => result.report.usages.filter((u) => u.element === element).map((u) => `${u.file}:${u.line}`);
const rule = (slug: string) => result.report.violations.filter((v) => v.rule === `youi:signal/rule/${slug}`).map((v) => `${v.file}:${v.line}`);

describe("usage map", () => {
  test("report validates against the published youi.usage/v1 schema", () => {
    expect(ScanReport.safeParse(result.report).success).toBe(true);
  });

  test("counts every Button that resolves to the owned implementation, and nothing else", () => {
    expect(sites(BUTTON)).toEqual([
      "app/(tabs)/index.tsx:5",
      "app/(tabs)/index.tsx:6",
      "app/settings/index.tsx:7",
      "app/settings/index.tsx:8",
      "app/settings/index.tsx:11",
      "components/checkout-form.tsx:4",
      "components/orphan.tsx:2",
    ]);
  });

  test("follows path aliases, barrels, renamed imports and namespace members to the same identity", () => {
    const locals = result.report.usages.filter((u) => u.element === BUTTON && u.kind === "render").map((u) => u.local);
    expect(locals).toEqual(expect.arrayContaining(["Button", "Action", "ui.Button"]));
  });

  test("records sub-parts and variants functions under their element", () => {
    const card = result.report.usages.filter((u) => u.element === "youi:signal/component/card").map((u) => u.export);
    expect(card).toEqual(["Card", "CardHeader"]);
    const variants = result.report.usages.find((u) => u.kind === "variants");
    expect(variants).toMatchObject({ export: "buttonVariants", props: { variant: { literal: "link" } } });
  });

  test("keeps literal props, marks dynamic values and spreads", () => {
    const checkout = result.report.usages.find((u) => u.file === "components/checkout-form.tsx");
    expect(checkout).toMatchObject({ props: { variant: { dynamic: "cta" } }, spread: true });
  });

  test("a same-named component from elsewhere is a lookalike, never a usage", () => {
    expect(result.report.lookalikes).toEqual([
      expect.objectContaining({ file: "app/settings/index.tsx", line: 9, local: "LegacyButton", resolved: "components/legacy/button.tsx#Button", resembles: BUTTON }),
    ]);
    expect(rule("components.canonical-import")).toEqual(["app/settings/index.tsx:9"]);
  });

  test("unresolvable tags are unknowns, not zero and not usages", () => {
    expect(result.report.unknowns.map((u) => `${u.file}:${u.line} ${u.name} ${u.reason}`)).toEqual([
      "app/broken.tsx:1 Button dynamic-component",
      "app/settings/index.tsx:10 Comp dynamic-component",
    ]);
  });

  test("a file that does not parse makes the scan partial and is named", () => {
    expect(result.report.status).toBe("partial");
    expect(result.report.coverage.failed.map((f) => f.file)).toEqual(["app/broken.tsx"]);
  });
});

describe("routes", () => {
  test("expo-router paths become routes", () => {
    expect(expoRoute("app/(tabs)/index.tsx", "app")).toBe("/");
    expect(expoRoute("app/settings/index.tsx", "app")).toBe("/settings");
    expect(expoRoute("app/user/[id].tsx", "app")).toBe("/user/[id]");
    expect(expoRoute("app/(tabs)/_layout.tsx", "app")).toBeNull();
    expect(expoRoute("components/x.tsx", "app")).toBeNull();
  });

  test("shared components inherit the routes that import them; orphans say unrouted", () => {
    const byFile = (file: string) => result.report.usages.find((u) => u.file === file)!;
    expect(byFile("components/checkout-form.tsx")).toMatchObject({ routes: ["/checkout"], routeSource: "imported-by", via: "app/checkout/index.tsx" });
    expect(byFile("components/orphan.tsx")).toMatchObject({ routes: [], routeSource: "unrouted" });
    expect(byFile("app/(tabs)/_layout.tsx")).toMatchObject({ routes: ["/"], routeSource: "shell" });
    expect(byFile("app/settings/index.tsx")).toMatchObject({ routes: ["/settings"], routeSource: "route-file" });
  });
});

describe("checks", () => {
  test("enum props outside the contract are errors with the allowed values", () => {
    const violation = result.report.violations.find((v) => v.rule.endsWith("props.contract-values"));
    expect(violation).toMatchObject({ file: "app/(tabs)/index.tsx", line: 6, text: "variant=\"primary\"", severity: "error" });
    expect(violation?.suggestion).toContain("default");
  });

  test("raw colours are found in class names, style objects and stylesheets, with exact-value token candidates", () => {
    expect(rule("color.no-raw-color")).toEqual(["app/(tabs)/index.tsx:7", "app/(tabs)/index.tsx:8", "styles/app.css:1", "styles/tokens.css:2"]);
    const danger = result.report.violations.find((v) => v.text === "#c4320a");
    expect(danger?.suggestion).toContain("var(--so-danger)");
  });

  test("an issue number in prose is not a colour", () => {
    expect(result.report.violations.some((v) => v.text === "#123")).toBe(false);
  });

  test("token sources may define custom properties but nothing else", () => {
    expect(result.report.violations.filter((v) => v.file === "styles/tokens.css").map((v) => v.text)).toEqual(["color: #fafafa"]);
  });

  test("arbitrary values that copy a token suggest its utility", () => {
    const arbitrary = result.report.violations.find((v) => v.rule.endsWith("tokens.no-arbitrary-values"));
    expect(arbitrary).toMatchObject({ text: "rounded-[10px]", suggestion: "rounded-card" });
  });

  test("native controls outside the owned directory are flagged; hidden inputs are allowed", () => {
    expect(rule("components.no-native-controls")).toEqual(["app/(tabs)/index.tsx:9", "components/legacy/button.tsx:1"]);
  });

  test("youi-ignore silences one finding and is counted", () => {
    expect(result.report.violations.some((v) => v.text === "#ff00ff")).toBe(false);
    expect(result.report.suppressed).toBe(1);
  });
});

describe("review regressions", () => {
  test("unnormalized config paths resolve the same as clean ones", async () => {
    const project = await loadProject(FIXTURE);
    const messy = { ...project, config: normalizeProjectConfig({ ...project.config, componentsDir: "./components/ui/", routes: { ...project.config.routes, appDir: "./app" } }) };
    const report = (await scanProject(messy)).report;
    expect(report.usages.filter((u) => u.element === BUTTON)).toHaveLength(7);
    expect(report.usages.find((u) => u.file === "app/settings/index.tsx")?.routes).toEqual(["/settings"]);
  });

  test("a missing tsconfig makes the scan partial and alias imports unknown, not external", async () => {
    const project = await loadProject(FIXTURE);
    const report = (await scanProject({ ...project, config: { ...project.config, tsconfig: "tsconfig.base.json" } })).report;
    expect(report.status).toBe("partial");
    expect(report.coverage.failed.map((f) => f.file)).toContain("tsconfig.base.json");
    expect(report.unknowns.some((u) => u.reason === "unresolved-import" && u.candidate === BUTTON)).toBe(true);
    expect(report.lookalikes.filter((l) => l.resolved.startsWith("@/"))).toEqual([]);
  });

  test("colour context, fragments, ignore scope and default exports", async () => {
    const project = await loadProject(FIXTURE);
    const file = "app/review.tsx";
    const code = [
      "import Home from \"./(tabs)/index\";",
      "export default function Review() {",
      "  const x = 1; // youi-ignore",
      "  return <div style={{ border: \"1px solid #ff0000\", boxShadow: \"0 1px 2px #000\" }}><a href=\"#fade\">Top</a><Home /></div>;",
      "}",
    ].join("\n");
    const report = (await scanProject(project, { overrides: { [file]: code } })).report;
    const colours = report.violations.filter((v) => v.file === file && v.rule.endsWith("no-raw-color")).map((v) => v.text);
    expect(colours).toEqual(["#ff0000", "#000"]);
    expect(report.unknowns.filter((u) => u.file === file)).toEqual([]);
  });
});
