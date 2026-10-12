/**
 * Library > Stack: the UI libraries a repo or website uses, as `youi detect` found them. Each
 * library with its confidence and evidence, each element type with its screenshot, what the
 * report covers, and packages declared but never imported. "Add to Library" drafts a
 * youi.library/v1 item from an element, to copy or download: nothing is written from here.
 */
import { draftLibraryItem } from "@youiyoux/core/detect-draft";
import * as Dialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { Download, FileSearch, Info, Layers, LibraryBig, X } from "lucide-react";
import { useState } from "react";
import { dataUrl } from "../../data/load.ts";
import { retryDetect, useDetectState } from "../../data/store.ts";
import type { DetectElement, DetectEvidence, DetectLibrary, DetectReport } from "../../data/types.ts";
import { Badge, type BadgeTone } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, ResourceState } from "../../ui/Pane.tsx";
import { Section, Table } from "../../ui/Section.tsx";

type Confidence = DetectLibrary["confidence"];
const TONE: Record<Confidence, BadgeTone> = { high: "success", medium: "warning", low: "neutral" };

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return <Badge tone={TONE[confidence]}>{confidence[0]!.toUpperCase() + confidence.slice(1)} confidence</Badge>;
}

const KIND_LABEL: Record<DetectEvidence["kind"], string> = {
  package: "package.json",
  lockfile: "lockfile",
  "components-json": "components.json",
  import: "import",
  "data-slot": "data-slot",
  "class-prefix": "class",
  "css-var": "CSS variable",
  "id-prefix": "id",
  "style-tag": "style tag",
  "radix-colors": "Radix Colors",
  tailwind: "Tailwind",
};

function EvidenceList({ evidence }: { evidence: readonly DetectEvidence[] }) {
  return (
    <ul className="space-y-1.5">
      {evidence.map((e) => (
        <li key={`${e.kind}:${e.detail}`} className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 text-small max-sm:grid-cols-1">
          <span className={clsx("font-mono text-mono-sm", e.strength === "support" ? "text-muted" : "text-ink-2")}>
            {KIND_LABEL[e.kind]}
            {e.strength === "support" && <span className="sr-only"> (supporting only)</span>}
          </span>
          <span className="min-w-0 space-y-0.5">
            <span className={clsx("block", e.strength === "support" ? "text-muted" : "text-ink")}>
              {e.detail}
              {e.count > 1 && <span className="tabular text-muted"> ×{e.count}</span>}
              {e.strength === "support" && <span className="text-muted"> · supports, never decides</span>}
            </span>
            {e.samples.length > 0 && <span className="block truncate font-mono text-mono-sm text-muted">{e.samples.join("  ")}</span>}
            {e.where.length > 0 && <span className="block truncate font-mono text-mono-sm text-muted">{e.where.slice(0, 3).join("  ")}{e.where.length > 3 ? `  +${e.where.length - 3}` : ""}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LibraryCard({ library, report }: { library: DetectLibrary; report: DetectReport }) {
  const types = report.elements.filter((e) => e.library === library.id).map((e) => e.type);
  return (
    <article aria-label={library.name} className="space-y-3 rounded-lg border border-line p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-heading">{library.name}</h3>
        <ConfidenceBadge confidence={library.confidence} />
        <span className="tabular text-small text-muted">score {library.score.toFixed(2)}</span>
        {report.target.kind === "site" && library.pages.length > 0 && <span className="ml-auto text-small text-muted max-sm:ml-0 max-sm:w-full">seen on {library.pages.length} of {report.pages.length} pages</span>}
      </header>
      <EvidenceList evidence={library.evidence} />
      {types.length > 0 && <p className="text-small text-muted">Elements: {types.join(", ")}</p>}
    </article>
  );
}

/** A .library.json file for the draft, built in the browser and handed to the download. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DraftDialog({ report, element, onClose }: { report: DetectReport; element: DetectElement; onClose: () => void }) {
  const [draft] = useState(() => draftLibraryItem(report, element));
  const text = `${JSON.stringify(draft, null, 2)}\n`;
  const [source, name] = draft.id.slice("lib:".length).split("/component/");
  const file = `library/${source}/${name}.library.json`;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade" />
        <Dialog.Content className="fixed inset-x-0 top-[10vh] z-50 mx-auto w-[min(560px,calc(100vw-24px))] rounded-xl border border-line bg-surface shadow-popover outline-none animate-pop">
          <header className="flex h-12 items-center border-b border-line px-5">
            <Dialog.Title className="text-heading">Draft Library item</Dialog.Title>
            <Dialog.Close aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink">
              <X className="size-4" />
            </Dialog.Close>
          </header>
          <div className="space-y-4 p-5">
            <Dialog.Description className="text-small text-ink-2">
              {draft.summary}. A draft only: nothing is written. Save it as <span className="font-mono text-mono-sm text-ink">{file}</span> in the design repo; it lands in the Library, never the System, until a person adopts it.
            </Dialog.Description>
            <CodeBlock code={text} title={file} maxHeight="sm" />
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => download(`${name}.library.json`, text)}>
                <Download /> Download
              </Button>
              <Dialog.Close asChild>
                <Button>Close</Button>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ElementCard({ element, report, onDraft }: { element: DetectElement; report: DetectReport; onDraft: () => void }) {
  const library = report.libraries.find((l) => l.id === element.library);
  const label = `${library?.name ?? element.library} ${element.type}`;
  return (
    <article aria-label={label} className="flex flex-col overflow-hidden rounded-lg border border-line">
      <div className="grid h-36 place-items-center border-b border-line bg-sunken p-3">
        {element.screenshot ? (
          <img src={dataUrl(element.screenshot)} alt={`Screenshot: ${label}`} loading="lazy" className="max-h-full max-w-full rounded-xs object-contain shadow-raise" />
        ) : (
          <span className="text-small text-muted">{report.target.kind === "repo" ? "Found in the code: no screenshot" : "No screenshot taken"}</span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-heading capitalize">{element.type}</h3>
          <span className="text-small text-ink-2">{library?.name ?? element.library}</span>
          <ConfidenceBadge confidence={element.confidence} />
        </div>
        <p className="truncate font-mono text-mono-sm text-muted" title={element.evidence[0]?.detail}>
          {element.evidence[0]?.detail} {element.count > 1 && `×${element.count}`}
        </p>
        {element.also.length > 0 && <p className="text-caption text-muted">Also matched: {element.also.map((id) => report.libraries.find((l) => l.id === id)?.name ?? id).join(", ")}</p>}
        <div className="mt-auto pt-1">
          <Button size="sm" onClick={onDraft}>
            <LibraryBig /> Add to Library
          </Button>
        </div>
      </div>
    </article>
  );
}

function Coverage({ report }: { report: DetectReport }) {
  return (
    <section aria-label="Coverage" className="flex items-start gap-3 rounded-lg border border-dashed border-line-strong p-4">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-small text-ink-2">{report.coverage}</p>
        {report.pages.length > 0 && (
          <ul className="space-y-0.5">
            {report.pages.map((page) => (
              <li key={page.url} className="flex items-center gap-2 text-small">
                <Badge tone={page.status === "ok" ? "neutral" : "danger"}>{page.status === "ok" ? "Crawled" : "Failed"}</Badge>
                <span className="min-w-0 truncate font-mono text-mono-sm text-ink-2">{page.url}</span>
                {page.exposed > 0 && <span className="text-muted">{page.exposed} opened</span>}
                {page.error && <span className="text-danger">{page.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function StackReport({ report }: { report: DetectReport }) {
  const [drafting, setDrafting] = useState<DetectElement | null>(null);
  return (
    <div className="mx-auto w-full max-w-5xl min-w-0 space-y-8 px-8 py-8 animate-enter max-sm:px-4">
      <div className="space-y-1">
        <p className="text-small text-muted">
          {report.target.kind === "site" ? "Website" : "Repo"} · detected {new Date(report.generatedAt).toLocaleString()} · {report.detector}
        </p>
        <h2 className="text-title">{report.target.name}</h2>
      </div>
      <Coverage report={report} />
      <Section title="Libraries" count={report.libraries.length}>
        {report.libraries.length === 0 ? <p className="text-small text-muted">No UI library found on what was crawled.</p> : <div className="space-y-3">{report.libraries.map((library) => <LibraryCard key={library.id} library={library} report={report} />)}</div>}
      </Section>
      <Section title="Elements" count={report.elements.length}>
        {report.elements.length === 0 ? (
          <p className="text-small text-muted">No element types matched.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {report.elements.map((element) => (
              <ElementCard key={element.type} element={element} report={report} onDraft={() => setDrafting(element)} />
            ))}
          </div>
        )}
      </Section>
      {report.unused.length > 0 && (
        <Section title="Declared, never imported" count={report.unused.length} aside={<span className="text-small text-muted">Not counted in any verdict</span>}>
          <Table head={["Package", "Declared", "In", "Library"]}>
            {report.unused.map((u) => (
              <tr key={u.package}>
                <td className="font-mono text-mono-sm text-ink">{u.package}</td>
                <td className="font-mono text-mono-sm text-muted">{u.version}</td>
                <td className="font-mono text-mono-sm text-muted">{u.declaredIn}</td>
                <td className="text-small text-ink-2">{u.library ?? ""}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
      {report.fonts.length > 0 && (
        <Section title="Fonts" count={report.fonts.length}>
          <p className="text-small text-ink-2">{report.fonts.map((f) => `${f.family}${f.usedBy.length ? ` (${f.usedBy.slice(0, 3).join(", ")})` : ""}`).join(" · ")}</p>
        </Section>
      )}
      {report.notes.length > 0 && (
        <Section title="Not counted">
          <ul className="list-disc space-y-1 pl-5 text-small text-muted">
            {report.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Section>
      )}
      {drafting && <DraftDialog report={report} element={drafting} onClose={() => setDrafting(null)} />}
    </div>
  );
}

export function StackEmpty() {
  return (
    <EmptyState icon={FileSearch} title="No stack detected yet">
      <p>
        Run <span className="font-mono text-mono-sm text-ink">youi detect &lt;repo-path|url…&gt;</span> to find which UI libraries a repo or website uses, then open the hub with{" "}
        <span className="font-mono text-mono-sm text-ink">youi ui --detect .youi/detect/detect.json</span>.
      </p>
    </EmptyState>
  );
}

export function StackScreen() {
  const state = useDetectState();
  const report = state.status === "ready" ? state.value : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader title="Stack" {...(report ? { count: report.libraries.length } : {})}>
        <Badge tone="outline">
          <Layers /> Detected, not adopted
        </Badge>
      </PaneHeader>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{state.status !== "ready" ? <ResourceState state={state} onRetry={retryDetect} what="the detect report" /> : report ? <StackReport report={report} /> : <StackEmpty />}</div>
    </div>
  );
}
