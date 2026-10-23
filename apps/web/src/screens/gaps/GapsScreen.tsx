/**
 * Library > Gaps: for each inventoried project, the kinds of element it builds by hand and the
 * ones the standard kit has that it lacks, each with the licensed candidates that could stand in
 * (`youiyoux gaps`, youi.gaps/v1, written by the snapshot beside the inventory); then what it
 * has from the System and from libraries. Kinds built by hand in more than one project lead: the
 * System could own them once. Candidates open in Discover; nothing is installed from here.
 */
import type { GapCandidate, GapConcept, GapsProject, GapsReport } from "@youiyoux/core";
import { ArrowRight, Puzzle, ScanSearch } from "lucide-react";
import { Link } from "wouter";
import { EMPTY_QUERY, queryToSearch } from "../../data/discover.ts";
import { retryGaps, useGapsState } from "../../data/store.ts";
import { plural } from "../../lib/plural.ts";
import { Badge } from "../../ui/Badge.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, ResourceState } from "../../ui/Pane.tsx";
import { Facts, Section } from "../../ui/Section.tsx";
import { LicenceBadge } from "../discover/LicenceBadge.tsx";

/** Discover, searching for the kind, with one candidate open when it is given. */
export const discoverHref = (concept: Pick<GapConcept, "concept" | "name">, open: string | null = null): string => `/discover${queryToSearch({ ...EMPTY_QUERY, q: concept.name, role: concept.concept, open })}`;

/** A kind as a heading: `date picker` → `Date picker`, an initialism in capitals (`otp` → `OTP`). */
export const kindLabel = (name: string): string => (/^[a-z]{1,3}$/.test(name) ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1));

/** What was found for a hand-built kind, in words: `3 components named for it, 12 uses in 5 files`. */
export function evidence(c: GapConcept): string {
  const parts = [c.count ? `${plural(c.count, "component")} named for it` : null, c.uses ? plural(c.uses, "use") : null].filter(Boolean);
  return `${parts.join(", ")} in ${plural(c.files, "file")}`;
}

function Candidates({ concept, discover }: { concept: GapConcept; discover: GapsReport["discover"] }) {
  if (concept.candidates === null || discover === "not-synced") return <p className="text-small text-muted">No candidates yet: Discover is not synced.</p>;
  if (concept.candidates.length === 0) return <p className="text-small text-muted">No licensed candidate in the index.</p>;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label={`Candidates for ${concept.name}`}>
      {concept.candidates.map((candidate: GapCandidate) => (
        <li key={candidate.id} className="flex min-w-0 items-center gap-1.5">
          <Link href={discoverHref(concept, candidate.id)} className="truncate text-small font-medium text-accent hover:underline">
            {candidate.name}
          </Link>
          <span className="text-caption text-muted">{candidate.source}</span>
          <LicenceBadge licence={candidate.licence} />
        </li>
      ))}
    </ul>
  );
}

function HandBuilt({ concept, discover }: { concept: GapConcept; discover: GapsReport["discover"] }) {
  return (
    <li className="space-y-2.5 rounded-lg border border-line p-4" data-gap={concept.concept} data-status="hand-built">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-body font-medium text-ink">{kindLabel(concept.name)}</h4>
        <span className="text-small text-muted">{evidence(concept)}</span>
        <Link href={discoverHref(concept)} className="ml-auto inline-flex items-center gap-1 text-small text-muted hover:text-ink max-sm:ml-0">
          All in Discover <ArrowRight className="size-3.5" />
        </Link>
      </header>
      {concept.definitions.length > 0 && (
        <ul className="space-y-0.5 font-mono text-mono-sm text-ink-2">
          {concept.definitions.slice(0, 3).map((d) => (
            <li key={`${d.file}:${d.line}`} className="truncate">
              <span className="text-ink">{d.name}</span> <span className="text-muted">{d.file}:{d.line}</span>
            </li>
          ))}
          {concept.count > 3 && <li className="text-muted">+{concept.count - 3} more</li>}
        </ul>
      )}
      <Candidates concept={concept} discover={discover} />
    </li>
  );
}

function Missing({ concept, discover }: { concept: GapConcept; discover: GapsReport["discover"] }) {
  const top = concept.candidates?.[0];
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border border-line px-3 py-2.5" data-gap={concept.concept} data-status="missing">
      <Link href={discoverHref(concept)} className="text-small font-medium text-ink hover:text-accent">
        {kindLabel(concept.name)}
      </Link>
      {top ? (
        <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted">
          <Link href={discoverHref(concept, top.id)} className="truncate hover:text-ink">
            {top.name} · {top.source}
          </Link>
          <LicenceBadge licence={top.licence} />
        </span>
      ) : (
        <span className="text-caption text-muted">{discover === "not-synced" ? "Discover not synced" : "No licensed candidate"}</span>
      )}
    </li>
  );
}

function ProjectGaps({ project, report }: { project: GapsProject; report: GapsReport }) {
  const by = (status: GapConcept["status"]) => project.concepts.filter((c) => c.status === status);
  const hand = by("hand-built");
  const missing = by("missing");
  const system = by("system");
  const library = by("library");
  return (
    <Section
      title={project.id}
      count={`${hand.length} built by hand · ${missing.length} not in it`}
      aside={
        <>
          {!project.complete && <Badge tone="warning" title="Some files could not be read: counts are a lower bound">Partial</Badge>}
          {project.dependencies === "unread" && <Badge tone="outline" title="Its package.json was not read: libraries are known only from its imports">No package.json</Badge>}
        </>
      }
    >
      <div className="space-y-6" data-project={project.id}>
        {hand.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-small font-medium text-ink-2">Built by hand, with what could stand in</h4>
            <ul className="space-y-2">
              {hand.map((c) => (
                <HandBuilt key={c.concept} concept={c} discover={report.discover} />
              ))}
            </ul>
          </div>
        )}
        {missing.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-small font-medium text-ink-2">Not in it, from the standard kit</h4>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {missing.map((c) => (
                <Missing key={c.concept} concept={c} discover={report.discover} />
              ))}
            </ul>
          </div>
        )}
        {(system.length > 0 || library.length > 0) && (
          <Facts
            className="text-small"
            rows={[
              ...(system.length ? [[`In the System${report.system ? ` (${report.system})` : ""}`, system.map((c) => c.name).join(", ")] as const] : []),
              ...(library.length ? [["From libraries", library.map((c) => `${c.name} (${c.packages.join(", ")})`).join(", ")] as const] : []),
            ]}
          />
        )}
      </div>
    </Section>
  );
}

export function GapsReportView({ report }: { report: GapsReport }) {
  return (
    <div className="mx-auto w-full max-w-5xl min-w-0 space-y-8 px-8 py-8 animate-enter max-sm:px-4">
      <p className="max-w-2xl text-small text-ink-2">
        For each project, the kinds of element it builds by hand and the ones the standard kit has that it lacks, with licensed candidates from Discover. Suggestions only: open one to preview it in your theme and draft a request; nothing is installed.
      </p>
      {report.discover === "not-synced" && (
        <p className="rounded-md border border-line bg-sunken px-3 py-2 text-small text-ink-2" data-not-synced>
          No candidates yet: run <span className="font-mono text-mono-sm text-ink">youiyoux discover sync</span>, then open the hub again.
        </p>
      )}
      {report.across.length > 0 && (
        <Section title="Built by hand in more than one project" count={report.across.length} aside={<span className="text-small text-muted">Worth adding to the System once</span>}>
          <ul className="divide-y divide-line rounded-lg border border-line" data-across>
            {report.across.map((a) => (
              <li key={a.concept} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <Link href={discoverHref(a)} className="text-small font-medium text-ink hover:text-accent">
                  {kindLabel(a.name)}
                </Link>
                <span className="flex flex-wrap gap-1">
                  {a.projects.map((p) => (
                    <Badge key={p} tone="neutral">
                      {p}
                    </Badge>
                  ))}
                </span>
                <span className="ml-auto tabular text-small text-muted">{plural(a.uses, "use")}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {report.projects.map((project) => (
        <ProjectGaps key={project.id} project={project} report={report} />
      ))}
    </div>
  );
}

export function GapsEmpty() {
  return (
    <EmptyState icon={ScanSearch} title="No gaps to show yet">
      <p>
        Gaps come with an inventory: run <span className="font-mono text-mono-sm text-ink">youiyoux inventory</span> in a project, then open the hub with <span className="font-mono text-mono-sm text-ink">youiyoux ui --inventory .youi/inventory.json</span>. Or run{" "}
        <span className="font-mono text-mono-sm text-ink">youiyoux gaps</span> in the terminal.
      </p>
    </EmptyState>
  );
}

export function GapsScreen() {
  const state = useGapsState();
  const report = state.status === "ready" ? state.value : null;
  const open = report ? report.projects.reduce((n, p) => n + p.concepts.filter((c) => c.status === "hand-built" || c.status === "missing").length, 0) : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader title="Gaps" count={open}>
        <Badge tone="outline">
          <Puzzle /> Suggestions, never installed
        </Badge>
      </PaneHeader>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{state.status !== "ready" ? <ResourceState state={state} onRetry={retryGaps} what="the gaps" /> : report ? <GapsReportView report={report} /> : <GapsEmpty />}</div>
    </div>
  );
}
