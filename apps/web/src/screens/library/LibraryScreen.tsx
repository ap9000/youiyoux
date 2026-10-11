/**
 * The Library: what YouIyouX ingests from outside, kept apart from the System. No sources
 * are connected yet, so the page explains what will land here, how an item moves into the
 * System, and what agents may do with it.
 */
import type { ElementStage } from "@youiyoux/core";
import { ArrowRight, Bot, Boxes, Library, PlugZap } from "lucide-react";
import { Link } from "wouter";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { PaneHeader } from "../../ui/Pane.tsx";

interface StageCopy {
  readonly by: string;
  readonly body: string;
}

/** Every stage, in order; typed by core's stage list so a new stage cannot be left off. */
export const STAGES: Readonly<Record<ElementStage, StageCopy>> = {
  library: { by: "Ingested", body: "Pulled in from a source, categorized, with the System elements it could replace." },
  candidate: { by: "Requested by a person or an agent", body: "Proposed for the System, or as a swap for an element already in use." },
  adopted: { by: "Approved by a person", body: "In the System with a contract, tokens and rules. Products may build with it." },
  "in-use": { by: "Read off the usage map", body: "Used on at least one scanned screen; every site is listed under Where." },
};

const AGENT_TOOLS: ReadonlyArray<{ name: string; does: string }> = [
  { name: "library_search", does: "Browse Library items and what each could swap in for" },
  { name: "library_request", does: "Draft an adoption request for a person to approve" },
  { name: "system_*", does: "Look up, check and plan with System elements: the only things agents build with" },
];

function StagePath() {
  const stages = Object.entries(STAGES) as Array<[ElementStage, StageCopy]>;
  return (
    <section aria-labelledby="library-stages" className="space-y-3">
      <h2 id="library-stages" className="text-heading">
        How an element moves into the System
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        {(["library", "system"] as const).map((area) => (
          <div key={area} className="space-y-2">
            <div className="flex items-center gap-2 border-b border-line pb-1.5 text-small font-medium text-ink-2">
              {area === "library" ? <Library className="size-3.5 text-muted" /> : <Boxes className="size-3.5 text-muted" />}
              {area === "library" ? "Library · browse and propose" : "System · build with"}
            </div>
            <ol className="grid gap-2 sm:grid-cols-2">
              {stages.slice(area === "library" ? 0 : 2, area === "library" ? 2 : 4).map(([stage, copy]) => (
                <li key={stage} className="space-y-1.5 rounded-lg border border-line p-3">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-mono-sm text-ink">{stage}</span>
                    {stage !== "in-use" && <ArrowRight aria-hidden className="ml-auto size-3 text-muted" />}
                  </div>
                  <p className="text-caption text-muted">{copy.by}</p>
                  <p className="text-small text-ink-2">{copy.body}</p>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentRules() {
  return (
    <section aria-labelledby="library-agents" className="space-y-3 rounded-lg border border-line bg-raised p-4">
      <h2 id="library-agents" className="flex items-center gap-2 text-heading">
        <Bot className="size-4 text-muted" /> What agents may do here
      </h2>
      <p className="text-small text-ink-2">Agents browse the Library and draft requests; they never import, copy or restyle a Library item, and only a person adopts one into the System.</p>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_minmax(0,1fr)]">
        {AGENT_TOOLS.map((tool) => (
          <div key={tool.name} className="contents">
            <dt className="font-mono text-mono-sm text-ink">{tool.name}</dt>
            <dd className="text-small text-muted max-sm:mb-1.5">{tool.does}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function LibraryScreen() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader title="Library" count={0}>
        <Badge tone="outline">Not built with</Badge>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-8 py-12 animate-enter max-sm:px-4 max-sm:py-8">
          <div className="space-y-3">
            <span className="grid size-9 place-items-center rounded-lg border border-line bg-raised text-muted">
              <Library className="size-4" />
            </span>
            <p className="max-w-xl text-reading text-ink-2">
              The Library holds what YouIyouX pulls in from outside: other design systems, UI kits and references. Browse it, sort it into categories, and propose an item as a new System element or a swap for one already in use. Nothing here ships in a product until a person adopts it into the System.
            </p>
          </div>
          <section aria-labelledby="library-sources" className="flex items-start gap-3 rounded-lg border border-dashed border-line-strong p-4">
            <PlugZap aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1 space-y-1">
              <h2 id="library-sources" className="text-heading">
                No sources connected yet
              </h2>
              <p className="text-small text-muted">Sources come later. Each one will add its elements here, categorized and linked to the System elements they could replace, with how widely each of those is used.</p>
            </div>
          </section>
          <StagePath />
          <AgentRules />
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href="/elements">Browse System elements</Link>
            </Button>
            <span className="text-small text-muted">The System is what products and agents build with.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
