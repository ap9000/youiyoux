/** Home: the system at a glance, where it lives, how healthy it is, and how fast the hub is running. */
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import { elementHref } from "../../data/ids.ts";
import { countByKind, type Model } from "../../data/model.ts";
import type { CatalogRule } from "../../data/types.ts";
import { retryModel, useModelState, useUsageState } from "../../data/store.ts";
import { summarize, type UsageIndex } from "../../data/usage.ts";
import { BUDGETS, percentile, useSamples } from "../../lib/perf.ts";
import { Badge, SeverityBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { Disclosure } from "../../ui/Disclosure.tsx";
import { Num } from "../../ui/Num.tsx";
import { ResourceState } from "../../ui/Pane.tsx";
import { Section, Table } from "../../ui/Section.tsx";
import { MostUsed } from "./MostUsed.tsx";

const SHORT_SHA = 7;

/** The headline (rule data.headline): one sentence that carries the numbers, never a row of equal boxes. */
function Headline({ counts, projects, sites, violations }: { counts: ReturnType<typeof countByKind>; projects: number | null; sites: number | null; violations: number | null }) {
  const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
  return (
    <p data-headline className="max-w-3xl text-title text-ink-2">
      <Num value={counts.component} href="/elements" /> {plural(counts.component, "component")}, <Num value={counts.token} href="/tokens" /> {plural(counts.token, "token")} and <Num value={counts.rule} href="/elements" /> {plural(counts.rule, "rule")}
      {projects !== null && sites !== null && violations !== null ? (
        <>
          , used at <Num value={sites} href="/screens" /> {plural(sites, "site")} in <Num value={projects} href="/screens" /> {plural(projects, "project")}
          {violations > 0 ? (
            <>
              {" "}
              with <Num value={violations} /> {plural(violations, "violation")}.
            </>
          ) : (
            <>
              {" "}
              with <Num value="no" clean /> violations.
            </>
          )}
        </>
      ) : (
        "."
      )}
    </p>
  );
}

function Bar({ label, value, max, href, trailing }: { label: ReactNode; value: number; max: number; href: string; trailing?: ReactNode }) {
  return (
    <li>
      <Link href={href} className="group grid grid-cols-[minmax(0,42%)_1fr_auto] items-center gap-3 rounded-md px-2 py-1 hover:bg-raised">
        <span className="truncate text-body text-ink-2 group-hover:text-ink">{label}</span>
        <span className="h-1.5 overflow-hidden rounded-full bg-raised">
          <span className="block h-full rounded-full bg-ink-2" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
        </span>
        <span className="flex items-center gap-2 tabular text-small text-muted">
          {trailing}
          {value}
        </span>
      </Link>
    </li>
  );
}

/** One timing for the speed line: the median and p95 against the budget, or plainly no samples. */
function Timing({ label, samples, budget }: { label: string; samples: readonly number[]; budget: number }) {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  if (p50 === null || p95 === null) return <span>{label} no samples yet</span>;
  return (
    <span className="tabular">
      {label} {p50.toFixed(1)} ms median, p95 {p95.toFixed(1)} ms{" "}
      {p95 <= budget ? `(budget ${budget} ms)` : <span className="text-danger">over its {budget} ms budget</span>}
    </span>
  );
}

/** Live timings for this tab: a footnote, not a panel, so it never outweighs the system. */
export function SpeedNote({ samples }: { samples: ReturnType<typeof useSamples> }) {
  return (
    <p data-speed className="border-t border-line pt-4 text-small text-muted">
      Speed in this tab: <Timing label="search" samples={samples.search} budget={BUDGETS.searchMs} />; <Timing label="navigation" samples={samples.navigation} budget={BUDGETS.navigationMs} />.
    </p>
  );
}

/** Rules with nothing broken, folded under one line (rule lists.bounded); opened, each links to its rule. */
function CleanRules({ rules }: { rules: readonly CatalogRule[] }) {
  if (rules.length === 0) return null;
  return (
    <Disclosure
      className="mt-1"
      summaryClassName="-mx-2 rounded-md px-2 py-1 text-body hover:bg-raised"
      summary={
        <span className="text-success">
          {rules.length} {rules.length === 1 ? "rule" : "rules"} clean
        </span>
      }
    >
      <ul className="-mx-2 mt-0.5 space-y-0.5">
        {rules.map((rule) => (
          <li key={rule.id}>
            <Link href={elementHref(rule.id)} className="flex items-center gap-3 rounded-md px-2 py-1 text-body text-ink-2 hover:bg-raised hover:text-ink">
              <span className="min-w-0 flex-1 truncate">{rule.title}</span>
              <span className="tabular text-small text-muted">0</span>
            </Link>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

export function Usage({ model, index, scheme }: { model: Model; index: UsageIndex; scheme: Scheme }) {
  const rules = [...model.rules.values()].map((rule) => ({ rule, count: index.violationsByRule.get(rule.id)?.length ?? 0 })).sort((a, b) => b.count - a.count);
  const broken = rules.filter((r) => r.count > 0);
  const clean = rules.filter((r) => r.count === 0).map((r) => r.rule);
  const maxViolations = broken[0]?.count ?? 0;
  return (
    <>
      <Section title={`Where ${model.catalog.system.name} lives`} count={index.reports.length}>
        <Table head={["Project", "Commit", "Scan", "Sites", "Screens", "Violations"]}>
          {index.reports.map((report) => {
            const summary = summarize(report.usages.map((u) => ({ ...u, project: report.project, commit: report.commit })));
            return (
              <tr key={report.project}>
                <td className="font-medium text-ink">{report.project}</td>
                <td className="font-mono text-mono-sm text-muted">{report.commit?.slice(0, SHORT_SHA) ?? "–"}</td>
                <td>
                  <Badge tone={report.status === "complete" ? "success" : "warning"} title={report.scanner}>
                    {report.status}
                  </Badge>
                </td>
                <td className="tabular text-ink-2">{summary.sites}</td>
                <td className="tabular text-ink-2">{summary.screens}</td>
                <td className="tabular text-ink-2">{report.violations.length}</td>
              </tr>
            );
          })}
        </Table>
      </Section>
      <Section title="Most used components" aside={<span className="text-small text-muted">uses in scanned projects</span>}>
        <MostUsed model={model} index={index} scheme={scheme} />
      </Section>
      <Section title="Rule health" aside={<span className="text-small text-muted">violations in projects</span>}>
        {broken.length > 0 && (
          <ul className="-mx-2 space-y-0.5">
            {broken.map(({ rule, count }) => (
              <Bar key={rule.id} label={rule.title} value={count} max={maxViolations} href={elementHref(rule.id)} trailing={<SeverityBadge severity={rule.severity} />} />
            ))}
          </ul>
        )}
        <CleanRules rules={clean} />
      </Section>
    </>
  );
}

export function HomeScreen() {
  const state = useModelState();
  if (state.status !== "ready") return <ResourceState state={state} onRetry={retryModel} what="the design language" />;
  return <Home model={state.value} />;
}

function Home({ model }: { model: Model }) {
  const usage = useUsageState();
  const samples = useSamples();
  const { scheme } = useTheme();
  const counts = countByKind(model.elements);
  const { system } = model.catalog;
  const index = usage.status === "ready" ? usage.value : null;
  const sites = index ? index.reports.reduce((sum, r) => sum + r.usages.length, 0) : null;
  const violations = index ? index.reports.reduce((sum, r) => sum + r.violations.length, 0) : null;
  const commit = model.manifest.source.commit;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-10 px-8 py-10 animate-enter max-md:px-5">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-display">{system.name}</h1>
            <Badge tone="outline" className="tabular">
              v{system.version}
            </Badge>
            {commit && (
              <span className="font-mono text-mono-sm text-muted" title="The commit that last changed these definitions">
                @{commit.slice(0, SHORT_SHA)}
              </span>
            )}
            {violations !== null && violations > 0 && (
              <Button asChild className="ml-auto">
                <Link href="/rules">
                  Review {violations === 1 ? "the violation" : `${violations} violations`} <ArrowRight />
                </Link>
              </Button>
            )}
          </div>
          <Headline counts={counts} projects={index ? index.reports.length : null} sites={sites} violations={violations} />
          <p className="max-w-2xl text-reading text-muted">{system.description}</p>
        </header>

        {index ? <Usage model={model} index={index} scheme={scheme} /> : <ResourceState state={usage} onRetry={() => location.reload()} what="the usage map" />}

        <SpeedNote samples={samples} />
      </div>
    </div>
  );
}
