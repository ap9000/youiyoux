/**
 * A component's page. A quiet header (name, status, one line of facts) with one primary
 * verb, Propose change; sync and copy live in a secondary menu. Then four tabs:
 * Overview, Usage, Contract & tokens, Rules.
 */
import { ClipboardCopy, Download, Ellipsis, GitPullRequestArrow, Hash, PackageOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { type ElementTab, elementHref, parseId } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { useUsageState } from "../../data/store.ts";
import type { ComponentEntry } from "../../data/types.ts";
import { elementIssues } from "../../data/usage.ts";
import { markNavigation } from "../../lib/perf.ts";
import { Badge, StatusBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { MenuButton } from "../../ui/Menu.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs.tsx";
import { ContractTab } from "./ContractTab.tsx";
import { OverviewTab } from "./OverviewTab.tsx";
import { RulesTab } from "./RulesTab.tsx";
import { UsageTab } from "./UsageTab.tsx";

const STATUS_MS = 1600;
/** What brings a project's owned components up to date: it vendors the whole system, not one component. */
export const SYNC_COMMAND = "youiyoux sync";
/** Where `youiyoux init` points imports when a project has an `@/` alias; projects can set their own `importFrom`. */
const DEFAULT_IMPORT_FROM = "@/components/ui";

/** npm packages a component's files import (everything but relative paths and React itself). */
export function packageDeps(files: ComponentEntry["files"]): string[] {
  const deps = new Set<string>();
  for (const { code } of files) {
    for (const match of code.matchAll(/from\s+"([^".][^"]*)"/g)) {
      const spec = match[1]!;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (name !== "react" && name !== "react-dom") deps.add(name);
    }
  }
  return [...deps].sort();
}

export function importLine(entry: ComponentEntry): string {
  const { source } = entry.contract;
  return `import { ${[source.export, ...source.also].join(", ")} } from "${DEFAULT_IMPORT_FROM}";`;
}

function SyncPanel({ entry, onClose }: { entry: ComponentEntry; onClose: () => void }) {
  const deps = packageDeps(entry.files);
  return (
    <div className="mt-4 grid gap-3 rounded-lg border border-line bg-sunken p-4 animate-enter">
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface py-1 pr-1 pl-3 font-mono text-mono">
        <span className="text-faint select-none">$</span>
        <span className="flex-1 text-ink">{SYNC_COMMAND}</span>
        <CopyButton value={SYNC_COMMAND} label="Copy sync command" />
      </div>
      <p className="text-small text-muted">
        Run in a project, it vendors every component of the system, {entry.contract.name}&rsquo;s <span className="font-mono text-ink-2">{entry.files.map((f) => f.path).join(", ")}</span> among them, into the project&rsquo;s components folder as owned code, records each file in <span className="font-mono text-ink-2">youi.lock.json</span>, and merges later updates with the project&rsquo;s own edits. A project not set up yet starts with <span className="font-mono text-ink-2">youiyoux init --design &lt;dir&gt;</span>.
      </p>
      <div className="flex flex-wrap items-center gap-1.5 text-small text-muted">
        {deps.length > 0 && (
          <>
            Adds
            {deps.map((dep) => (
              <Badge key={dep} tone="outline" className="font-mono">
                {dep}
              </Badge>
            ))}
          </>
        )}
        <button type="button" onClick={onClose} className="ml-auto text-small text-muted hover:text-ink">
          Close
        </button>
      </div>
    </div>
  );
}

/** Copy to the clipboard and say so in a polite live region. */
function useCopyStatus(): { status: string; copy: (value: string, what: string) => void } {
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);
  const copy = (value: string, what: string): void => {
    navigator.clipboard.writeText(value).then(
      () => setStatus(`Copied ${what}`),
      () => setStatus("The browser blocked the clipboard"),
    );
  };
  return { status, copy };
}

export function ComponentPage({ model, entry, tab }: { model: Model; entry: ComponentEntry; tab: ElementTab }) {
  const { contract } = entry;
  const [, navigate] = useLocation();
  const [syncing, setSyncing] = useState(false);
  const { status, copy } = useCopyStatus();
  const usage = useUsageState();
  const sites = usage.status === "ready" ? (usage.value.sitesByElement.get(contract.id)?.length ?? 0) : undefined;
  const issues = usage.status === "ready" ? elementIssues(usage.value, contract).total : 0;
  const name = parseId(contract.id)?.name ?? contract.name.toLowerCase();
  const owners = contract.owners.map((o) => o.replace(/^group:/, ""));

  const selectTab = (next: string): void => {
    const href = elementHref(contract.id, next as ElementTab);
    markNavigation(href);
    navigate(href, { replace: true });
  };

  return (
    <article className="flex min-h-0 flex-1 flex-col animate-enter">
      <header className="shrink-0 px-6 pt-5 pb-4 max-sm:px-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 data-detail-heading tabIndex={-1} className="truncate text-title outline-none">
                {contract.name}
              </h2>
              <StatusBadge status={contract.status} />
            </div>
            <p className="max-w-2xl text-reading text-ink-2">{contract.summary}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span role="status" aria-live="polite" className="text-small text-muted max-md:sr-only">
              {status}
            </span>
            <Button variant="primary" asChild>
              <Link href="/changes">
                <GitPullRequestArrow /> <span className="max-sm:hidden">Propose change</span>
              </Link>
            </Button>
            <MenuButton
              label={`More for ${contract.name}`}
              items={[
                { label: "Copy sync command", detail: SYNC_COMMAND, icon: Download, onSelect: () => copy(SYNC_COMMAND, "the sync command") },
                { label: "Copy import", detail: importLine(entry), icon: ClipboardCopy, onSelect: () => copy(importLine(entry), "the import") },
                { label: "Copy element id", detail: contract.id, icon: Hash, onSelect: () => copy(contract.id, "the element id") },
                { label: "What sync does", detail: "Files, lockfile and dependencies", icon: PackageOpen, onSelect: () => setSyncing(true) },
              ]}
            >
              <Ellipsis />
            </MenuButton>
          </div>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-muted">
          <span className="tabular">v{contract.version}</span>
          <span aria-hidden className="text-faint">·</span>
          <span>{contract.platforms.join(", ")}</span>
          {owners.length > 0 && (
            <>
              <span aria-hidden className="text-faint">·</span>
              <span>{owners.join(", ")}</span>
            </>
          )}
          <span aria-hidden className="text-faint">·</span>
          <span className="inline-flex min-w-0 items-center font-mono text-mono-sm text-faint">
            <span className="truncate">{contract.id}</span>
            <CopyButton value={contract.id} label="Copy element id" className="size-5" />
          </span>
        </p>
        {syncing && <SyncPanel entry={entry} onClose={() => setSyncing(false)} />}
      </header>
      <Tabs value={tab} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label={`${contract.name} sections`} className="max-sm:px-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="usage" count={sites}>
            Usage
            {issues > 0 && <span aria-label={`${issues} to look at`} className="size-1.5 rounded-full bg-warning" />}
          </TabsTrigger>
          <TabsTrigger value="contract">Contract & tokens</TabsTrigger>
          <TabsTrigger value="rules" count={contract.rules.length}>
            Rules
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <OverviewTab model={model} name={name} contract={contract} usage={usage} />
        </TabsContent>
        <TabsContent value="usage" className="flex min-h-0 flex-1 flex-col outline-none">
          <UsageTab model={model} contract={contract} usage={usage} />
        </TabsContent>
        <TabsContent value="contract" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <ContractTab model={model} entry={entry} />
        </TabsContent>
        <TabsContent value="rules" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <RulesTab model={model} contract={contract} />
        </TabsContent>
      </Tabs>
    </article>
  );
}
