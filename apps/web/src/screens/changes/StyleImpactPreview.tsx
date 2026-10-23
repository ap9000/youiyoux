/**
 * What a style draft reaches: every token whose value changes (and why), the components that
 * change with them, every site of those components in the project (by file or by screen, in
 * pages), every direct use of the tokens, the colour pairs it puts below WCAG AA, and what the
 * preview cannot promise. Totals always count everything, whatever is listed.
 */
import { clsx } from "clsx";
import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { StyleContrast, StylePreview, StyleSite } from "../../data/workflow.ts";
import { Badge, type BadgeTone } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { Section } from "../../ui/Section.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { Swatch } from "../../ui/Swatch.tsx";
import { plural } from "../../lib/plural.ts";

const PAGE = 40;
const COLOR = /^(?:#[0-9a-f]{3,8}|rgb\()/i;

const CHANGE: Record<StyleContrast["change"], { label: string; tone: BadgeTone }> = {
  new: { label: "Below AA", tone: "danger" },
  kept: { label: "Still below AA", tone: "warning" },
  fixed: { label: "Now passes", tone: "success" },
};

function Value({ css }: { css: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {COLOR.test(css) && <Swatch color={css} size="xs" />}
      <code className="truncate font-mono text-mono-sm text-ink-2" title={css}>
        {css}
      </code>
    </span>
  );
}

function BeforeAfter({ before, after }: { before: string; after: string }) {
  if (before === after) return <span className="text-small text-faint">unchanged</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5 text-muted line-through decoration-faint">
        <Value css={before} />
      </span>
      <Value css={after} />
    </span>
  );
}

type Grouping = "file" | "route";

function groupSites(sites: readonly StyleSite[], by: Grouping): Array<[string, StyleSite[]]> {
  const groups = new Map<string, StyleSite[]>();
  for (const site of sites) {
    const keys = by === "file" ? [site.file] : site.routes.length > 0 ? site.routes : [site.routeSource === "shell" ? "* (app shell)" : "Not on any screen"];
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), site]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/** Every site, grouped, a page at a time: the totals above always count all of them. */
function Sites({ preview }: { preview: StylePreview }) {
  const [by, setBy] = useState<Grouping>("file");
  const [pages, setPages] = useState(1);
  const groups = useMemo(() => groupSites(preview.sites, by), [preview, by]);
  const shown = groups.slice(0, pages * PAGE);
  return (
    <Section title="Where it shows" count={`${preview.totals.sites} site(s)`} aside={<Segmented<Grouping> label="Group sites by" value={by} onChange={(next) => { setBy(next); setPages(1); }} options={[{ value: "file", label: "By file" }, { value: "route", label: "By screen" }]} />}>
      {preview.sites.length === 0 ? (
        <p className="text-small text-muted">No component that changes is used in the project.</p>
      ) : (
        <>
          <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
            {shown.map(([key, sites]) => (
              <li key={key} className="px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-mono-sm text-ink">{key}</span>
                  <span className="tabular text-small text-muted">{sites.length}</span>
                </div>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {sites.map((site) => (
                    <li key={`${site.file}:${site.line}:${site.column}:${key}`} className="font-mono text-mono-sm text-muted">
                      {by === "route" && <span className="text-ink-2">{site.file}</span>}:{site.line} <span className="text-ink-2">{site.export}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="flex flex-wrap items-center gap-2 text-small text-muted">
            Showing {shown.length} of {groups.length} {by === "file" ? "files" : "screens"} ({plural(preview.sites.length, "site")}
            {preview.truncated ? ` listed of ${preview.totals.sites}` : ""}).
            {shown.length < groups.length && (
              <Button size="sm" onClick={() => setPages((n) => n + 1)}>
                Show {Math.min(PAGE, groups.length - shown.length)} more
              </Button>
            )}
          </p>
        </>
      )}
    </Section>
  );
}

export function StyleImpactPreview({ preview, project, stale }: { preview: StylePreview; project: string; stale: boolean }) {
  const { totals } = preview;
  const [showFollows, setShowFollows] = useState(false);
  const edited = preview.tokens.filter((t) => t.cause === "edited");
  const follows = preview.tokens.filter((t) => t.cause === "follows");
  const contrast = preview.contrast.filter((c) => c.change !== "fixed");
  return (
    <div className={clsx("space-y-6", stale && "opacity-60")}>
      <div className="space-y-1">
        <p className="text-title">
          Changes <span className="tabular">{plural(totals.tokens, "token")}</span> and <span className="tabular">{plural(totals.contracts, "component")}</span>
        </p>
        <p className="text-small text-muted">
          <span className="tabular">{totals.sites}</span> component site(s) and <span className="tabular">{totals.direct}</span> direct use(s) in <span className="tabular">{plural(totals.files, "file")}</span>, on <span className="tabular">{plural(totals.routes, "screen")}</span>
          {preview.everyScreen ? ", and possibly every screen" : ""}
        </p>
        <p className="font-mono text-mono-sm text-muted">
          {project}
          {preview.snapshot.projectCommit ? ` @ ${preview.snapshot.projectCommit.slice(0, 7)}` : ""}
          {preview.snapshot.projectChanges ? " + uncommitted edits" : ""} · {plural(preview.scan.files, "file")} scanned · {preview.durationMs} ms · {new Date(preview.at).toLocaleTimeString()}
        </p>
      </div>

      {preview.contrast.length > 0 && (
        <Section title="Contrast" count={contrast.length ? `${contrast.length} below AA` : "all pass"}>
          <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
            {preview.contrast.map((c) => (
              <li key={`${c.label}|${c.scheme}`} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small text-ink">{c.label}</span>
                  <span className="block text-caption text-muted capitalize">
                    {c.scheme} · needs {c.required}:1 · was {c.before?.toFixed(2) ?? "–"}
                  </span>
                </span>
                <span className="tabular font-mono text-mono-sm text-ink">{c.after?.toFixed(2) ?? "–"}</span>
                <Badge tone={CHANGE[c.change].tone}>{CHANGE[c.change].label}</Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {preview.limits.length > 0 && (
        <ul className="space-y-1.5 rounded-md bg-warning-soft px-3 py-2">
          {preview.limits.map((limit) => (
            <li key={limit} className="flex gap-2 text-small text-ink-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              {limit}
            </li>
          ))}
        </ul>
      )}

      <Section title="Tokens" count={totals.tokens}>
        <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
          {[...edited, ...(showFollows ? follows : [])].map((t) => (
            <li key={t.path} className="grid gap-1.5 px-3 py-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-mono-sm text-ink">{t.path}</span>
                {t.cause === "follows" && <Badge tone="neutral">follows</Badge>}
              </span>
              <span className="min-w-0 text-small">
                <span className="text-caption text-muted">Light </span>
                <BeforeAfter {...t.light} />
              </span>
              <span className="min-w-0 text-small">
                <span className="text-caption text-muted">Dark </span>
                <BeforeAfter {...t.dark} />
              </span>
            </li>
          ))}
        </ul>
        {follows.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowFollows((v) => !v)}>
            {showFollows ? "Hide" : "Show"} {plural(follows.length, "token")} that follow through aliases
          </Button>
        )}
      </Section>

      <Section title="Components" count={totals.contracts}>
        {preview.contracts.length === 0 ? (
          <p className="text-small text-muted">No contract binds or implements these tokens.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
            {preview.contracts.map((c) => (
              <li key={c.id} className="flex h-9 items-center gap-2 px-3">
                <span className="font-medium text-ink">{c.name}</span>
                <Badge tone="outline">{c.via === "binding" ? "binds a changed token" : c.via === "state" ? "state re-bound" : "implementation uses one"}</Badge>
                <span className="ml-auto tabular text-small text-muted">{plural(c.sites, "site")}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {preview.routes.length > 0 && (
        <Section title="Screens" count={totals.routes}>
          <ul className="flex flex-wrap gap-1.5">
            {preview.routes.map((r) => (
              <li key={r.route}>
                <Badge tone="neutral">
                  <span className="font-mono">{r.route}</span> {r.sites + r.direct}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Sites preview={preview} />

      <Section title="Direct uses" count={`${totals.direct} in ${plural(totals.directFiles, "file")}`}>
        {preview.direct.length === 0 ? (
          <p className="text-small text-muted">No file outside the owned components reads these tokens' variables or utilities.</p>
        ) : (
          <ul className="max-h-[24rem] divide-y divide-line overflow-y-auto rounded-md border border-line">
            {preview.direct.map((d) => (
              <li key={d.file} className="space-y-0.5 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-mono-sm text-ink">
                    {d.file}
                    <span className="text-muted">:{d.line}</span>
                  </span>
                  <span className="tabular text-small text-muted">{plural(d.uses, "use")}</span>
                </div>
                <code className="block truncate font-mono text-mono-sm text-muted">{d.text}</code>
              </li>
            ))}
          </ul>
        )}
        {preview.direct.length < totals.directFiles && (
          <p role="note" className="flex items-center gap-1.5 text-small text-ink-2">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
            Showing {preview.direct.length.toLocaleString("en-US")} of {totals.directFiles.toLocaleString("en-US")} files with direct uses; the count above includes them all.
          </p>
        )}
      </Section>
    </div>
  );
}
