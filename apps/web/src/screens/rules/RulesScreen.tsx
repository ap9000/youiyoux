/**
 * System → Rules: every rule with what it checks, how hard it bites, and where the project
 * breaks it. Edit and New rule start here; a draft opens on its rule's own page
 * (/rules/draft/<id>): the form, Run preview, Approve, Send for review.
 *
 * Live from the rule editor (`youiyoux ui --project`) when it runs; otherwise the snapshot, read-only.
 */
import { clsx } from "clsx";
import { PencilLine, Plus, ShieldCheck } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, Redirect, useLocation, useParams } from "wouter";
import { elementHref, parseId } from "../../data/ids.ts";
import { retryModel, useModelState, useUsageState } from "../../data/store.ts";
import type { CatalogRule, RuleSpec } from "../../data/types.ts";
import { asRequestError, type DraftView, type PublishedRules, type WorkflowInfo, workflowApi, useRemote } from "../../data/workflow.ts";
import { Badge, SeverityBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, PaneSkeleton, ResourceState, SplitView } from "../../ui/Pane.tsx";
import { Facts, Section } from "../../ui/Section.tsx";
import { DraftEditor, DraftStatusBadge } from "../changes/DraftEditor.tsx";
import { ServiceDown, StartEditor } from "../changes/ServiceDown.tsx";
import { executionLabel } from "@youiyoux/core/rules";
import { notRunIn } from "../element/RuleDetail.tsx";
import { checkLabel, executionOf } from "../element/RulesTab.tsx";

const MAX_PLACES = 60;
const OPEN: ReadonlySet<DraftView["status"]> = new Set(["draft", "previewed", "approved"]);

interface Place {
  readonly project?: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly message: string;
}

interface RuleRow {
  readonly rule: CatalogRule;
  readonly components: readonly string[];
  /** null when no scan is known, or the rule did not run on it (`notRun` says why). */
  readonly flagged: number | null;
  readonly notRun?: string;
  readonly places: readonly Place[];
  readonly draft: DraftView | null;
}

interface Live {
  readonly info: WorkflowInfo;
  readonly published: PublishedRules;
  readonly drafts: readonly DraftView[];
}

async function loadLive(): Promise<Live> {
  const [info, published, { drafts }] = await Promise.all([workflowApi.info(), workflowApi.rules(), workflowApi.drafts()]);
  return { info, published, drafts };
}

const nameOf = (id: string): string => parseId(id)?.name ?? id;

export function RulesScreen() {
  const params = useParams<{ "*"?: string }>();
  const [first, second] = (params["*"] ?? "").split("/");
  const live = useRemote(loadLive, "rules");
  if (live.state.status === "loading") return <PaneSkeleton />;
  if (first === "draft" && second) {
    if (live.state.status === "error") return <ServiceDown error={live.state.error} onRetry={live.reload} />;
    return <DraftPage id={second} live={live.state.value} onChanged={live.reload} />;
  }
  if (live.state.status === "ready") return <Rules rows={liveRows(live.state.value)} selected={first || null} live={live.state.value} onChanged={live.reload} />;
  return <OfflineRules selected={first || null} />;
}

function liveRows(live: Live): RuleRow[] {
  return live.published.rules
    .map(({ rule, components, flagged, notRun, places }) => ({ rule, components, flagged, ...(notRun ? { notRun } : {}), places, draft: live.drafts.find((d) => d.kind === "rule" && d.ruleId === rule.id && OPEN.has(d.status)) ?? null }))
    .sort((a, b) => a.rule.title.localeCompare(b.rule.title));
}

/** Without the service: the snapshot's rules and violations, read-only. */
function OfflineRules({ selected }: { selected: string | null }) {
  const model = useModelState();
  const usage = useUsageState();
  const rows = useMemo((): RuleRow[] | null => {
    if (model.status !== "ready") return null;
    const index = usage.status === "ready" ? usage.value : null;
    return [...model.value.rules.values()].map((rule) => {
      const places = index?.violationsByRule.get(rule.id) ?? null;
      const notRun = index ? notRunIn(index.reports, rule) : [];
      return { rule, components: model.value.ruleComponents.get(rule.id) ?? [], flagged: places?.length ?? null, ...(notRun.length ? { notRun: notRun.join("; ") } : {}), places: places ?? [], draft: null };
    });
  }, [model, usage]);
  if (!rows) return <ResourceState state={model} onRetry={retryModel} what="the catalog" />;
  return <Rules rows={rows} selected={selected} live={null} onChanged={() => undefined} />;
}

interface RulesProps {
  rows: readonly RuleRow[];
  selected: string | null;
  live: Live | null;
  onChanged: () => void;
}

function Rules({ rows, selected, live, onChanged }: RulesProps) {
  const [, navigate] = useLocation();
  const [failure, setFailure] = useState<string | null>(null);
  const row = selected ? (rows.find((r) => nameOf(r.rule.id) === selected) ?? null) : null;
  const open = async (make: () => Promise<DraftView>): Promise<void> => {
    setFailure(null);
    try {
      const draft = await make();
      onChanged();
      navigate(`/rules/draft/${draft.id}`);
    } catch (error: unknown) {
      setFailure(asRequestError(error).message);
    }
  };
  const edit = (r: RuleRow): void => {
    if (r.draft) navigate(`/rules/draft/${r.draft.id}`);
    else void open(() => workflowApi.edit(r.rule.id));
  };
  return (
    <SplitView
      listLabel="Rules"
      backHref="/rules"
      hasDetail={row !== null}
      list={
        <>
          <PaneHeader title="Rules" count={rows.length}>
            {live && (
              <Button variant="primary" size="sm" onClick={() => void open(workflowApi.create)}>
                <Plus /> New rule
              </Button>
            )}
          </PaneHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {failure && <p className="border-b border-line bg-danger-soft px-4 py-2 text-small text-ink-2">{failure}</p>}
            <p className="border-b border-line px-4 py-2.5 text-small text-muted">
              {live ? (
                <>
                  Live rules of <span className="font-medium text-ink-2">{live.info.project.id}</span>, from {live.info.design.branch}@{live.info.design.head.slice(0, 7)}. Places from a scan at {new Date(live.published.scannedAt).toLocaleTimeString()}.
                </>
              ) : (
                "From the snapshot. Start the rule editor to edit rules and see live places."
              )}
            </p>
            <ul>
              {rows.map((r) => (
                <RuleListItem key={r.rule.id} row={r} active={r === row} />
              ))}
            </ul>
          </div>
        </>
      }
      detail={row ? <RulePage row={row} live={live} onEdit={() => edit(row)} /> : <Intro live={live} />}
    />
  );
}

function RuleListItem({ row, active }: { row: RuleRow; active: boolean }) {
  return (
    <li>
      <Link href={`/rules/${nameOf(row.rule.id)}`} aria-current={active ? "page" : undefined} className={clsx("block border-b border-line px-4 py-2.5 hover:bg-raised", active && "bg-raised")}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body text-ink">{row.rule.title}</span>
          {row.draft && <DraftStatusBadge draft={row.draft} />}
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-small text-muted">
          <SeverityBadge severity={row.rule.severity} />
          {row.rule.rollout && <span>→ error{row.rule.rollout.after ? ` ${row.rule.rollout.after}` : " later"}</span>}
          <span className="truncate">{row.rule.check.engine === "advisory" ? "advisory" : row.rule.check.engine === "youi" ? row.rule.check.id : "custom check"}</span>
          <span className="ml-auto tabular">{row.flagged === null ? "" : row.flagged === 0 ? "clean" : `${row.flagged} ${row.flagged === 1 ? "place" : "places"}`}</span>
        </p>
      </Link>
    </li>
  );
}

function levelText(rule: RuleSpec): string {
  if (rule.severity === "error") return "Error: fails youiyoux check";
  if (rule.severity === "off") return "Off";
  return `Warning${rule.rollout ? `, becoming an error ${rule.rollout.after ? `after ${rule.rollout.after}` : "later"}` : ""}`;
}

function RulePage({ row, live, onEdit }: { row: RuleRow; live: Live | null; onEdit: () => void }) {
  const { rule } = row;
  const label = live?.info.checks.find((c) => (rule.check.engine === "youi" ? c.id === rule.check.id : c.engine === rule.check.engine))?.label;
  return (
    <article className="min-h-0 flex-1 overflow-y-auto animate-enter">
      <header className="border-b border-line px-6 pt-5 pb-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-2">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 data-detail-heading tabIndex={-1} className="text-title outline-none">
                {rule.title}
              </h2>
              <SeverityBadge severity={rule.severity} />
              {rule.rollout && <Badge tone="outline">→ error {rule.rollout.after ?? "later"}</Badge>}
            </div>
            <p className="truncate font-mono text-mono-sm text-muted">{rule.id}</p>
          </div>
          {live && (
            <Button variant={row.draft ? "outline" : "primary"} size="sm" onClick={onEdit}>
              <PencilLine /> {row.draft ? "Open draft" : "Edit rule"}
            </Button>
          )}
        </div>
        <p className="mt-3 max-w-2xl text-reading text-ink">{rule.statement}</p>
        {row.draft && (
          <p className="mt-2 flex items-center gap-2 text-small text-muted">
            <DraftStatusBadge draft={row.draft} /> A draft of this rule is open (revision {row.draft.revision}).
          </p>
        )}
      </header>
      <div className="space-y-8 p-6">
        <Section title="Where it is broken" count={row.flagged ?? undefined}>
          <Places row={row} />
        </Section>
        <div className="grid gap-8 lg:grid-cols-2">
          <Section title="How it is checked">
            <Facts
              rows={[
                ["Check", label ?? checkLabel(rule)],
                ["Level", levelText(rule)],
                ["Files", <code className="font-mono text-mono-sm">{rule.files.join(", ")}</code>],
                [
                  "Followed by",
                  row.components.length ? (
                    <span className="flex flex-wrap gap-x-2">
                      {row.components.map((id) => (
                        <Link key={id} href={elementHref(id, "rules")} className="text-accent hover:underline">
                          {nameOf(id)}
                        </Link>
                      ))}
                    </span>
                  ) : (
                    "No component yet"
                  ),
                ],
              ]}
            />
          </Section>
          <Section title="Why">
            <p className="text-body text-ink-2">{rule.rationale || "No rationale recorded."}</p>
          </Section>
        </div>
        <Section title="For agents">
          <blockquote className="rounded-md border-l-2 border-line-strong bg-sunken px-3 py-2 text-body text-ink-2">{rule.agent}</blockquote>
        </Section>
        {(rule.examples.bad.length > 0 || rule.examples.good.length > 0) && (
          <div className="grid gap-4 md:grid-cols-2">
            <Section title="Breaks the rule">
              <CodeBlock code={rule.examples.bad.join("\n")} maxHeight="sm" />
            </Section>
            <Section title="Follows the rule">
              <CodeBlock code={rule.examples.good.join("\n")} maxHeight="sm" />
            </Section>
          </div>
        )}
      </div>
    </article>
  );
}

function Places({ row }: { row: RuleRow }) {
  const execution = executionOf(row.rule);
  // "Nothing breaks this rule" only when it actually ran: a rule nothing checks says so instead.
  if (execution.state !== "enforced") return <p className="text-body text-muted">{executionLabel(execution)}.</p>;
  if (row.notRun) return <p className="text-body text-muted">It did not run on the latest scan ({row.notRun}), so where it is broken is unknown.</p>;
  if (row.flagged === null) return <p className="text-body text-muted">No scan of a project yet.</p>;
  if (row.flagged === 0) return <p className="text-body text-muted">Nothing breaks this rule.</p>;
  const shown = row.places.slice(0, MAX_PLACES);
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <ul className="max-h-[28rem] divide-y divide-line overflow-y-auto">
        {shown.map((p) => (
          <li key={`${p.project ?? ""}:${p.file}:${p.line}:${p.column}:${p.text}`} className="space-y-1 px-3 py-2">
            <div className="flex items-center gap-2 font-mono text-mono-sm">
              {p.project && <span className="text-muted">{p.project}</span>}
              <span className="truncate text-ink-2">
                {p.file}
                <span className="text-muted">:{p.line}</span>
              </span>
            </div>
            <p className="text-small text-ink-2">{p.message}</p>
            <code className="block truncate font-mono text-mono-sm text-muted">{p.text}</code>
          </li>
        ))}
      </ul>
      {row.flagged > shown.length && <p className="border-t border-line bg-sunken px-3 py-2 text-small text-muted">and {row.flagged - shown.length} more; youiyoux check lists them all</p>}
    </div>
  );
}

function Intro({ live }: { live: Live | null }) {
  return (
    <EmptyState icon={ShieldCheck} title="Rules">
      <p>What each rule checks, how hard it bites, and every place the project breaks it. Pick one to see it. Edit opens a draft on the rule's own page: the form, Run preview, Approve, Send for review.</p>
      {!live && (
        <div className="mt-3 space-y-2">
          <p>To edit or add rules, start the rule editor and open the link it prints:</p>
          <StartEditor />
        </div>
      )}
    </EmptyState>
  );
}

/** A draft on its rule's own page. Reached from Rules (Edit, New rule) and from the Changes queue. */
/** Rules / <the rule> / draft, and All changes: one line at any width; the rule's title gives way (truncates), never the crumbs around it. */
export function DraftBreadcrumb({ title, href }: { title: string; href: string | null }) {
  return (
    <nav aria-label="Breadcrumb" className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-6 text-small whitespace-nowrap text-muted max-sm:px-4" data-draft-breadcrumb>
      <Link href="/rules" className="shrink-0 hover:text-ink">
        Rules
      </Link>
      <span aria-hidden>/</span>
      {href ? (
        <Link href={href} className="min-w-0 truncate hover:text-ink">
          {title}
        </Link>
      ) : (
        <span className="min-w-0 truncate">{title}</span>
      )}
      <span aria-hidden>/</span>
      <span className="shrink-0 text-ink-2">draft</span>
      <Link href="/changes" className="ml-auto shrink-0 pl-2 hover:text-ink">
        All changes
      </Link>
    </nav>
  );
}

function DraftPage({ id, live, onChanged }: { id: string; live: Live; onChanged: () => void }) {
  const load = useCallback(() => workflowApi.draft(id), [id]);
  const { state, reload, set } = useRemote(load, id);
  const onUpdate = useCallback(
    (draft: DraftView) => {
      set(draft);
      onChanged();
    },
    [set, onChanged],
  );
  if (state.status === "loading") return <PaneSkeleton />;
  if (state.status === "error") return <ServiceDown error={state.error} onRetry={reload} />;
  const draft = state.value;
  // Style drafts are reviewed in Changes.
  if (draft.kind !== "rule") return <Redirect to={`/changes/${draft.id}`} replace />;
  const published = live.published.rules.some((r) => r.rule.id === draft.ruleId);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DraftBreadcrumb title={draft.content.rule.title || "New rule"} href={published ? `/rules/${nameOf(draft.ruleId)}` : null} />
      <DraftEditor draft={draft} info={live.info} onUpdate={onUpdate} />
    </div>
  );
}
