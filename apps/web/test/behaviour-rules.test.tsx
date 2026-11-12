// @vitest-environment jsdom
/**
 * Behaviour rules in the hub before any probe has run: a rule nobody has checked reads "not run",
 * never "clean" or "Nothing breaks this rule"; a behaviour draft's preview says it is not counted on
 * code instead of "Flags nothing"; the rule form offers the behaviour checks.
 */
import { BEHAVIOUR_CHECKS, BEHAVIOUR_NOT_RUN } from "@youiyoux/core/rules";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Model } from "../src/data/model.ts";
import { buildScreens } from "../src/data/screens.ts";
import type { CatalogRule, Manifest, ScanReport } from "../src/data/types.ts";
import { indexUsage } from "../src/data/usage.ts";
import { ScanBadge } from "../src/screens/home/HomeScreen.tsx";
import { IssueBadge } from "../src/screens/screens/IssueCounts.tsx";
import { IssueGroups } from "../src/screens/screens/ScreenDetail.tsx";
import type { CheckCapability, DraftContent, Preview, WorkflowInfo } from "../src/data/workflow.ts";
import { ImpactPreview } from "../src/screens/changes/ImpactPreview.tsx";
import { RuleForm } from "../src/screens/changes/RuleForm.tsx";
import { checkLabel, executionOf } from "../src/screens/element/RulesTab.tsx";
import { countText, Places } from "../src/screens/rules/RulesScreen.tsx";

afterEach(cleanup);

const ESCAPE = "youi:demo/rule/popup.escape";
const rule: CatalogRule = {
  schema: "youi.rule/v1",
  id: ESCAPE,
  title: "Esc closes popups",
  severity: "error",
  statement: "Esc closes every popup.",
  rationale: "",
  agent: "Close popups on Esc.",
  check: { engine: "behaviour", id: "dismiss-escape", options: {} },
  files: ["**/*.tsx"],
  examples: { bad: [], good: [] },
};

describe("a behaviour rule nobody has probed", () => {
  test("its execution is a probe, never enforced", () => {
    expect(executionOf(rule)).toEqual({ state: "probe", by: "behaviour:dismiss-escape" });
    expect(checkLabel(rule)).toContain("checked by a probe run in the running app, not by the code scan");
  });

  test("the rule page says it has not run, not that nothing breaks it", () => {
    render(<Places row={{ rule, flagged: 0, notRun: BEHAVIOUR_NOT_RUN, places: [] }} />);
    expect(screen.getByText(/^Not run yet:/).textContent).toBe(`Not run yet: ${BEHAVIOUR_NOT_RUN}, so where it is broken is unknown.`);
    expect(screen.queryByText("Nothing breaks this rule.")).toBeNull();
  });

  test("the rule list counts it as not run, never clean", () => {
    expect(countText({ flagged: 0, notRun: BEHAVIOUR_NOT_RUN })).toBe("not run");
    expect(countText({ flagged: null, notRun: BEHAVIOUR_NOT_RUN })).toBe("not run");
    expect(countText({ flagged: 0 })).toBe("clean");
    expect(countText({ flagged: 3, notRun: "one project did not run it" })).toBe("3 places");
  });
});

describe("a behaviour draft", () => {
  const preview: Preview = {
    id: "p-1",
    at: "2026-11-12T10:00:00.000Z",
    draftRevision: 1,
    draftDigest: "d",
    snapshot: { designCommit: "abc1234", designDirty: false, project: "app", projectCommit: "def5678", projectChanges: null, scanner: "x", digest: "s" },
    durationMs: 10,
    scan: { status: "complete", files: 12, failed: [] },
    enforced: false,
    notOnSnapshot: "Behaviour rules are checked by a probe run in the running app, not on the code snapshot, so this preview cannot count what the rule would flag.",
    flagged: 0,
    counts: { new: 0, kept: 0, resolved: 0, suppressed: 0 },
    baseline: 0,
    files: 0,
    findings: [],
    truncated: false,
    limits: ["Behaviour rules are checked by a probe run in the running app, not on the code snapshot, so this preview cannot count what the rule would flag."],
  };

  test("its preview says it is not counted on the code, never 'Flags nothing' or a row of zeros", () => {
    const { container } = render(<ImpactPreview preview={preview} project="app" stale={false} />);
    expect(screen.getByText("Not counted on the code")).toBeTruthy();
    expect(container.textContent).not.toContain("Flags nothing");
    expect(container.textContent).not.toContain("already flagged");
    expect(container.textContent).toContain("checked by a probe run in the running app");
  });

  const info: WorkflowInfo = {
    schema: "youiyoux.workflow/v1",
    version: "0.1.0",
    actor: { kind: "person", name: "captain" },
    design: { root: "/d", branch: "main", head: "abc1234", dirty: false },
    project: { id: "app", root: "/p", system: "demo" },
    // The shape the service offers (packages/workflow/src/execution.ts; its own test pins the full list).
    checks: [
      { engine: "youi", id: "raw-color", label: "Raw colours", description: "Hex colours.", options: "none", defaults: {} },
      ...Object.entries(BEHAVIOUR_CHECKS).map(([id, check]): CheckCapability => ({ engine: "behaviour", id, label: `Behaviour: ${id}`, description: check.description, options: "none", defaults: {} })),
      { engine: "advisory", id: null, label: "Advisory (not checked)", description: "Guidance.", options: "none", defaults: {} },
    ],
    executor: "youiyoux check",
    components: [],
    kinds: ["rule"],
    limits: [],
  };
  const content = (check: DraftContent["rule"]["check"]): DraftContent => ({ rule: { id: ESCAPE, title: rule.title, severity: "error", rollout: null, statement: rule.statement, rationale: "", agent: rule.agent, check, files: ["**/*.tsx"], examples: { bad: [], good: [] } }, components: [] });

  test("the form shows its behaviour check and what it verifies, and offers every behaviour check", () => {
    render(<RuleForm value={content({ engine: "behaviour", id: "dismiss-escape", options: {} })} onChange={() => undefined} info={info} mode="create" readOnly={false} problems={[]} />);
    const select = screen.getByLabelText("Check") as HTMLSelectElement;
    expect(select.value).toBe("behaviour:dismiss-escape");
    expect(screen.getByText(/^Esc closes the popup \(APG/)).toBeTruthy();
    const behaviourOptions = [...select.options].filter((o) => o.value.startsWith("behaviour:")).map((o) => o.value);
    expect(behaviourOptions).toEqual(["behaviour:trigger-state", "behaviour:dismiss-escape", "behaviour:focus-into", "behaviour:focus-return", "behaviour:focus-trap", "behaviour:arrow-keys"]);
  });

  test("picking a behaviour check writes engine behaviour with that id; picking a built-in goes back", () => {
    const onChange = vi.fn();
    render(<RuleForm value={content({ engine: "youi", id: "raw-color", options: {} })} onChange={onChange} info={info} mode="create" readOnly={false} problems={[]} />);
    fireEvent.change(screen.getByLabelText("Check"), { target: { value: "behaviour:focus-trap" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rule: expect.objectContaining({ check: { engine: "behaviour", id: "focus-trap", options: {} } }) }));
  });
});

describe("a screen whose project has an unprobed behaviour rule", () => {
  const report: ScanReport = {
    schema: "youi.usage/v1",
    project: "app",
    system: "demo",
    commit: null,
    scanner: "test",
    configDigest: "x",
    generatedAt: "2026-11-12T00:00:00.000Z",
    durationMs: 1,
    status: "complete",
    coverage: { filesMatched: 1, filesScanned: 1, failed: [] },
    usages: [{ element: "youi:demo/component/button", kind: "render", export: "Button", local: "Button", props: {}, spread: false, file: "src/flows.tsx", line: 3, column: 1, routes: ["/flows"], routeSource: "route-file", fingerprint: "f" }],
    fileRoutes: { "src/flows.tsx": { routes: ["/flows"], routeSource: "route-file" } },
    unknowns: [],
    suppressed: 0,
    lookalikes: [],
    violations: [],
    checks: [
      { rule: "youi:demo/rule/color.no-raw-color", state: "ran", findings: 0 },
      { rule: ESCAPE, state: "incomplete", reason: BEHAVIOUR_NOT_RUN },
    ],
  };
  const manifest: Manifest = { schema: "youiyoux.manifest/v1", source: { commit: null }, systems: [{ id: "demo", catalog: "demo.catalog.json", usage: [{ project: "app", file: "app.usage.json" }] }] };
  const model = { rules: new Map([[ESCAPE, rule]]) } as unknown as Model;
  const flows = () => buildScreens(indexUsage([report]), manifest).screens.find((s) => s.route === "/flows")!;

  test("its badge says behaviour is not checked, in a neutral tone, never a green No issues", () => {
    const { container } = render(<IssueBadge issues={flows().issues} />);
    expect(container.textContent?.trim()).toBe("Behaviour not checked");
    expect(container.innerHTML).not.toContain("success");
    expect(container.firstElementChild?.getAttribute("title")).toBe("1 behaviour rule not checked");
  });

  test("its Rule issues say which behaviour rule was not checked and what to do, never 'No rule is broken'", () => {
    const { container } = render(<IssueGroups model={model} screen={flows()} />);
    expect(container.textContent).not.toContain("No rule is broken");
    expect(container.textContent).toContain("Behaviour not checked: Esc closes popups.");
    expect(container.textContent).toContain("check this screen's menus, dialogs and popovers yourself with the keyboard");
  });

  test("the project's scan badge on Home is not green while a rule did not run", () => {
    const { container } = render(<ScanBadge report={report} />);
    expect(container.textContent).toBe("behaviour not checked");
    expect(container.innerHTML).not.toContain("success");
    cleanup();
    const ran = render(<ScanBadge report={{ ...report, checks: [report.checks[0]!] }} />);
    expect(ran.container.textContent).toBe("complete");
  });
});
