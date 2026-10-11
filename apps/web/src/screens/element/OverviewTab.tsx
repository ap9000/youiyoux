/** Overview: the component itself first, then how much it is used and what needs a look, then examples. */
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { elementHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { type ElementScreen, routeLabel, screensOf, screensOfElement } from "../../data/screens.ts";
import type { Resource } from "../../data/store.ts";
import type { ComponentContract } from "../../data/types.ts";
import { elementIssues, summarize, type UsageIndex } from "../../data/usage.ts";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { Section } from "../../ui/Section.tsx";
import { stageFor } from "../tokens/TokenValue.tsx";
import { Preview } from "./Preview.tsx";

function Stat({ href, value, label, detail, tone = "neutral" }: { href: string; value: ReactNode; label: string; detail: ReactNode; tone?: "neutral" | "warning" }) {
  return (
    <Link href={href} className="group block space-y-0.5 rounded-lg border border-line px-4 py-3 transition-colors duration-100 hover:border-line-strong hover:bg-raised">
      <span className="flex items-baseline gap-1.5">
        <span className={clsx("tabular text-title", tone === "warning" ? "text-warning" : "text-ink")}>{value}</span>
        <span className="text-small text-muted">{label}</span>
      </span>
      <span className="block truncate text-small text-muted">{detail}</span>
    </Link>
  );
}

function topScreen(list: readonly ElementScreen[]): string {
  const top = list[0];
  return top ? `most on ${routeLabel(top.screen.route)} (${top.sites})` : "none routed";
}

function UsageGlance({ model, contract, index }: { model: Model; contract: ComponentContract; index: UsageIndex }) {
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
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat href={usage} value={summary.sites} label={summary.sites === 1 ? "use" : "uses"} detail={`in ${summary.files} files · ${summary.projects} ${summary.projects === 1 ? "project" : "projects"}`} />
      <Stat href={usage} value={summary.screens} label={summary.screens === 1 ? "screen" : "screens"} detail={topScreen(onScreens)} />
      <Stat href={usage} value={issues.total} label="to look at" detail={parts.length > 0 ? parts.join(" · ") : "nothing flagged"} tone={issues.total > 0 ? "warning" : "neutral"} />
    </div>
  );
}

const GLANCE_PLACEHOLDERS = 3;

export function OverviewTab({ model, name, contract, usage }: { model: Model; name: string; contract: ComponentContract; usage: Resource<UsageIndex> }) {
  return (
    <div className="space-y-8 p-6 max-sm:px-4">
      <Preview name={name} contract={contract} paper={{ light: stageFor(model, "light").background, dark: stageFor(model, "dark").background }} />
      {usage.status === "ready" ? (
        <UsageGlance model={model} contract={contract} index={usage.value} />
      ) : (
        <div aria-busy={usage.status !== "error"} className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: GLANCE_PLACEHOLDERS }, (_, i) => (
            <div key={i} className="h-[66px] rounded-lg border border-line bg-raised/50" />
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
