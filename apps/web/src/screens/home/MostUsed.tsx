/**
 * Most used components: a list of how many times each is used, and one panel for the chosen one
 * with its captured look, the files and lines it is used at, and the way in. The count is the
 * fact and the files are where to act on it, so neither hides behind a bar.
 */
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { Scheme } from "../../app/theme.tsx";
import { elementHref, parseId } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import type { ComponentContract } from "../../data/types.ts";
import type { Site, UsageIndex } from "../../data/usage.ts";
import { Button } from "../../ui/Button.tsx";
import { KindIcon } from "../../ui/KindIcon.tsx";
import { previewImage } from "../element/Preview.tsx";
import { stageFor } from "../tokens/TokenValue.tsx";

const TOP_COMPONENTS = 8;
/** Files listed in the panel before "and N more". */
const FILES_SHOWN = 6;
/** Line numbers listed per file before "+N". */
const LINES_SHOWN = 5;

export interface FileUses {
  readonly project: string;
  readonly file: string;
  /** Sorted, one per site, so a file used twice on a line lists it twice. */
  readonly lines: readonly number[];
}

/** Sites grouped by file, the busiest file first. */
export function filesOf(sites: readonly Site[]): FileUses[] {
  const byFile = new Map<string, { project: string; file: string; lines: number[] }>();
  for (const site of sites) {
    const key = `${site.project}\0${site.file}`;
    const entry = byFile.get(key) ?? { project: site.project, file: site.file, lines: [] };
    entry.lines.push(site.line);
    byFile.set(key, entry);
  }
  return [...byFile.values()]
    .map((entry) => ({ ...entry, lines: entry.lines.sort((a, b) => a - b) }))
    .sort((a, b) => b.lines.length - a.lines.length || a.file.localeCompare(b.file));
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function MostUsed({ model, index, scheme }: { model: Model; index: UsageIndex; scheme: Scheme }) {
  const components = [...model.components.values()]
    .map(({ contract }) => ({ contract, sites: index.sitesByElement.get(contract.id) ?? [] }))
    .sort((a, b) => b.sites.length - a.sites.length)
    .slice(0, TOP_COMPONENTS);
  const [chosen, setChosen] = useState(components[0]?.contract.id ?? "");
  if (components.length === 0) return <p className="text-body text-muted">The system defines no components.</p>;
  const manyProjects = index.reports.length > 1;

  return (
    <TabsPrimitive.Root value={chosen} onValueChange={setChosen} orientation="vertical" className="grid gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <TabsPrimitive.List aria-label="Most used components" className="-mx-2 flex flex-col gap-0.5 max-md:mx-0">
        {components.map(({ contract, sites }) => (
          <TabsPrimitive.Trigger
            key={contract.id}
            value={contract.id}
            className="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-body text-ink-2 outline-none hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus data-[state=active]:bg-raised data-[state=active]:text-ink"
          >
            <span className="min-w-0 flex-1 truncate">{contract.name}</span>
            <span className="tabular text-small text-muted">{sites.length}</span>
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {components.map(({ contract, sites }) => (
        <TabsPrimitive.Content key={contract.id} value={contract.id} className="min-w-0 outline-none">
          <Chosen model={model} contract={contract} sites={sites} scheme={scheme} manyProjects={manyProjects} />
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

function Chosen({ model, contract, sites, scheme, manyProjects }: { model: Model; contract: ComponentContract; sites: readonly Site[]; scheme: Scheme; manyProjects: boolean }) {
  const files = filesOf(sites);
  const projects = new Set(sites.map((site) => site.project)).size;
  const shown = files.slice(0, FILES_SHOWN);
  const usage = elementHref(contract.id, "usage");
  return (
    <div data-chosen={contract.id} className="overflow-hidden rounded-lg border border-line">
      <Look model={model} contract={contract} scheme={scheme} />
      <div className="space-y-3 border-t border-line p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p data-uses className="text-body text-ink">
            {sites.length === 0 ? (
              "Not used in any scanned project yet."
            ) : (
              <>
                <span className="font-medium">{plural(sites.length, "use")}</span> in {plural(files.length, "file")}
                {manyProjects && <> across {plural(projects, "project")}</>}
              </>
            )}
          </p>
          <Button asChild size="sm" className="ml-auto">
            <Link href={elementHref(contract.id)}>
              Open {contract.name} <ArrowRight />
            </Link>
          </Button>
        </div>
        {shown.length > 0 && (
          <ul className="space-y-1">
            {shown.map((entry) => (
              <li key={`${entry.project}:${entry.file}`} className="flex min-w-0 items-baseline gap-3">
                <span className="flex min-w-0 flex-1 font-mono text-mono-sm" title={`${entry.file}: lines ${entry.lines.join(", ")}`}>
                  <span className="min-w-0 truncate text-faint">{entry.file.slice(0, entry.file.lastIndexOf("/") + 1)}</span>
                  <span className="shrink-0 text-ink-2">{entry.file.slice(entry.file.lastIndexOf("/") + 1)}</span>
                  <span className="shrink-0 text-muted">
                    {entry.lines
                      .slice(0, LINES_SHOWN)
                      .map((line) => `:${line}`)
                      .join(" ")}
                    {entry.lines.length > LINES_SHOWN && ` +${entry.lines.length - LINES_SHOWN}`}
                  </span>
                </span>
                {manyProjects && <span className="shrink-0 text-caption text-faint">{entry.project}</span>}
                <span className="w-6 shrink-0 text-right tabular text-small text-muted">{entry.lines.length}</span>
              </li>
            ))}
          </ul>
        )}
        {sites.length > 0 && (
          <Link href={usage} className="inline-block text-small text-accent hover:underline">
            {files.length > shown.length ? `And ${plural(files.length - shown.length, "more file")}: every use` : "Every use with its props"}
          </Link>
        )}
      </div>
    </div>
  );
}

/** The component's captured look on its system's paper; its icon when nothing was captured. */
function Look({ model, contract, scheme }: { model: Model; contract: ComponentContract; scheme: Scheme }) {
  const [missing, setMissing] = useState(false);
  const name = parseId(contract.id)?.name ?? contract.name.toLowerCase();
  const element = model.byId.get(contract.id);
  return (
    <div className="grid min-h-24 place-items-start overflow-hidden" style={{ background: stageFor(model, scheme).background }}>
      {missing ? (
        <span className="flex h-24 w-full items-center justify-center gap-2 text-small text-muted">
          {element && <KindIcon element={element} scheme={scheme} />} No captured look for {contract.name} yet
        </span>
      ) : (
        <img
          key={`${name}.${scheme}`}
          src={previewImage(name, scheme)}
          srcSet={`${previewImage(name, scheme)} 2x`}
          alt={`${contract.name} in the ${scheme} scheme`}
          decoding="async"
          onError={() => setMissing(true)}
          className="block h-auto max-h-56 w-auto max-w-full object-contain object-left-top"
        />
      )}
    </div>
  );
}
