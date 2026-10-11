/** Home: the system at a glance, where it lives, how healthy it is, and how fast the hub is running. */
import { ArrowRight, Boxes, Palette } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { elementHref } from "../../data/ids.ts";
import { countByKind, type Model } from "../../data/model.ts";
import { retryModel, useModelState, useUsageState } from "../../data/store.ts";
import { summarize, type UsageIndex } from "../../data/usage.ts";
import { BUDGETS, percentile, useSamples } from "../../lib/perf.ts";
import { Badge, SeverityBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { Keys } from "../../ui/Kbd.tsx";
import { ResourceState } from "../../ui/Pane.tsx";
import { Section, Table } from "../../ui/Section.tsx";

const SHORT_SHA = 7;
const TOP_COMPONENTS = 8;

function Stat({ label, value, href }: { label: string; value: ReactNode; href?: string }) {
  const body = (
    <>
      <div className="tabular text-display">{value}</div>
      <div className="text-small text-muted">{label}</div>
    </>
  );
  const tile = "block rounded-lg border border-line bg-surface px-4 py-3 transition-colors duration-100";
  return href ? (
    <Link href={href} className={`${tile} hover:border-line-strong hover:bg-raised`}>
      {body}
    </Link>
  ) : (
    <div className={tile}>{body}</div>
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

function Budget({ label, samples, budget }: { label: string; samples: readonly number[]; budget: number }) {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const within = p95 === null || p95 <= budget;
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <div className="flex items-center justify-between text-small text-muted">
        {label}
        <Badge tone={p95 === null ? "outline" : within ? "success" : "danger"}>{p95 === null ? "no samples yet" : within ? "within budget" : "over budget"}</Badge>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="tabular text-display">{p50 === null ? "–" : p50.toFixed(1)}</span>
        <span className="text-small text-muted">
          ms median · p95 {p95 === null ? "–" : p95.toFixed(1)} · budget {budget} ms · {samples.length} samples
        </span>
      </div>
    </div>
  );
}

function Usage({ model, index }: { model: Model; index: UsageIndex }) {
  const components = [...model.components.values()]
    .map(({ contract }) => ({ contract, sites: index.sitesByElement.get(contract.id)?.length ?? 0 }))
    .sort((a, b) => b.sites - a.sites)
    .slice(0, TOP_COMPONENTS);
  const rules = [...model.rules.values()].map((rule) => ({ rule, count: index.violationsByRule.get(rule.id)?.length ?? 0 })).sort((a, b) => b.count - a.count);
  const maxSites = components[0]?.sites ?? 0;
  const maxViolations = rules[0]?.count ?? 0;
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
      <div className="grid gap-10 lg:grid-cols-2">
        <Section title="Most used components">
          <ul className="-mx-2 space-y-0.5">
            {components.map(({ contract, sites }) => (
              <Bar key={contract.id} label={contract.name} value={sites} max={maxSites} href={elementHref(contract.id, "usage")} />
            ))}
          </ul>
        </Section>
        <Section title="Rule health" aside={<span className="text-small text-muted">violations in projects</span>}>
          <ul className="-mx-2 space-y-0.5">
            {rules.map(({ rule, count }) => (
              <Bar key={rule.id} label={rule.title} value={count} max={maxViolations} href={elementHref(rule.id)} trailing={<SeverityBadge severity={rule.severity} />} />
            ))}
          </ul>
        </Section>
      </div>
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
  const counts = countByKind(model.elements);
  const { system } = model.catalog;
  const index = usage.status === "ready" ? usage.value : null;
  const sites = index ? index.reports.reduce((sum, r) => sum + r.usages.length, 0) : null;
  const violations = index ? index.reports.reduce((sum, r) => sum + r.violations.length, 0) : null;
  const commit = model.manifest.source.commit;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-10 px-8 py-10 animate-enter max-md:px-5">
        <header className="space-y-4">
          <div className="flex items-center gap-2 text-small text-muted">
            Design language
            {commit && <span className="font-mono text-mono-sm">@{commit.slice(0, SHORT_SHA)}</span>}
          </div>
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="text-display">{system.name}</h1>
            <Badge tone="outline" className="tabular">
              v{system.version}
            </Badge>
          </div>
          <p className="max-w-2xl text-reading text-ink-2">{system.description}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="primary" asChild>
              <Link href="/elements">
                <Boxes /> Browse elements <ArrowRight />
              </Link>
            </Button>
            <Button asChild>
              <Link href="/tokens">
                <Palette /> Token explorer
              </Link>
            </Button>
            <span className="ml-1 flex items-center gap-1.5 text-small text-muted">
              or press <Keys keys={["⌘", "K"]} /> to jump anywhere
            </span>
          </div>
        </header>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Components" value={counts.component} href="/elements" />
          <Stat label="Tokens" value={counts.token} href="/tokens" />
          <Stat label="Rules" value={counts.rule} href="/elements" />
          <Stat label="Projects" value={index ? index.reports.length : "–"} href="/screens" />
          <Stat label="Usage sites" value={sites ?? "–"} href="/screens" />
          <Stat label="Violations" value={violations ?? "–"} />
        </div>

        {index ? <Usage model={model} index={index} /> : <ResourceState state={usage} onRetry={() => location.reload()} what="the usage map" />}

        <Section title="Speed" aside={<span className="text-small text-muted">measured live in this tab</span>}>
          <div className="grid gap-3 md:grid-cols-2">
            <Budget label="Search (query to answer)" samples={samples.search} budget={BUDGETS.searchMs} />
            <Budget label="Navigation (input to paint)" samples={samples.navigation} budget={BUDGETS.navigationMs} />
          </div>
        </Section>
      </div>
    </div>
  );
}
