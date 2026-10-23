/** Overview: the component itself first, then how much it is used and what needs a look, then examples. */
import { elementHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { routeLabel, screensOf, screensOfElement } from "../../data/screens.ts";
import type { Resource } from "../../data/store.ts";
import type { ComponentContract } from "../../data/types.ts";
import { elementIssues, summarize, type UsageIndex } from "../../data/usage.ts";
import { noun } from "../../lib/plural.ts";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { Num } from "../../ui/Num.tsx";
import { Section } from "../../ui/Section.tsx";
import { stageFor } from "../tokens/TokenValue.tsx";
import { Preview } from "./Preview.tsx";

export function UsageGlance({ model, contract, index }: { model: Model; contract: ComponentContract; index: UsageIndex }) {
  const sites = index.sitesByElement.get(contract.id) ?? [];
  const summary = summarize(sites);
  const issues = elementIssues(index, contract);
  const onScreens = screensOfElement(screensOf(index, model.manifest), contract.id);
  const usage = elementHref(contract.id, "usage");
  if (sites.length === 0 && issues.total === 0) {
    return <p className="rounded-lg border border-dashed border-line px-4 py-3 text-small text-muted">No scanned project renders {contract.name} yet.</p>;
  }
  const parts = [
    issues.lookalikes > 0 && `${issues.lookalikes} lookalike${issues.lookalikes === 1 ? "" : "s"}`,
    issues.unset && `${issues.unset.count} without ${issues.unset.prop}`,
    issues.unresolved > 0 && `${issues.unresolved} unresolved`,
  ].filter(Boolean);
  const top = onScreens[0];
  return (
    <p data-headline className="text-title text-ink-2">
      <Num value={summary.sites} href={usage} /> {noun(summary.sites, "use")} in {summary.files} {noun(summary.files, "file")} across {summary.projects} {noun(summary.projects, "project")}, on <Num value={summary.screens} href={usage} /> {noun(summary.screens, "screen")}
      {top && (
        <>
          {" "}
          (most on <span className="font-mono text-mono">{routeLabel(top.screen.route)}</span>)
        </>
      )}
      {issues.total > 0 ? (
        <>
          , with <Num value={issues.total} href={usage} /> to look at: {parts.join(", ")}.
        </>
      ) : (
        <>
          , with <Num value="nothing" clean /> flagged.
        </>
      )}
    </p>
  );
}

/** The headline sentence while the usage map loads: two lines of bars at its real height. */
const GLANCE_PLACEHOLDERS = ["min(36rem, 100%)", "min(22rem, 70%)"];

export function OverviewTab({ model, name, contract, usage }: { model: Model; name: string; contract: ComponentContract; usage: Resource<UsageIndex> }) {
  return (
    <div className="space-y-8 p-6 max-sm:px-4">
      <Preview name={name} contract={contract} paper={{ light: stageFor(model, "light").background, dark: stageFor(model, "dark").background }} />
      {usage.status === "ready" ? (
        <UsageGlance model={model} contract={contract} index={usage.value} />
      ) : (
        <div aria-busy={usage.status !== "error"} aria-label={usage.status === "error" ? "Usage could not be loaded" : "Loading usage"} className="space-y-2">
          {GLANCE_PLACEHOLDERS.map((width, i) => (
            <div key={i} className="h-4 rounded-xs bg-raised" style={{ width }} />
          ))}
        </div>
      )}
      {contract.examples.length > 0 && (
        <Section title="Examples" count={contract.examples.length}>
          <div className="grid gap-3">
            {contract.examples.map((example) => (
              <CodeBlock key={example.title} title={example.title} code={example.code} maxHeight="sm" />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
