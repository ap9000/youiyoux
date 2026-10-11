/** A component's page: header with the Install verb, then Preview, Contract, Tokens, Rules and Where it lives. */
import { Box, ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { type ElementTab, elementHref, parseId } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { useUsageState } from "../../data/store.ts";
import type { ComponentEntry } from "../../data/types.ts";
import { summarize } from "../../data/usage.ts";
import { markNavigation } from "../../lib/perf.ts";
import { Badge, StatusBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs.tsx";
import { stageFor } from "../tokens/TokenValue.tsx";
import { ContractTab } from "./ContractTab.tsx";
import { PreviewTab } from "./PreviewTab.tsx";
import { RulesTab } from "./RulesTab.tsx";
import { TokensTab } from "./TokensTab.tsx";
import { WhereTab } from "./WhereTab.tsx";

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

function InstallPanel({ entry }: { entry: ComponentEntry }) {
  const name = parseId(entry.contract.id)?.name ?? entry.contract.name.toLowerCase();
  const command = `youi add ${name}`;
  const deps = packageDeps(entry.files);
  return (
    <div className="mt-4 grid gap-3 rounded-lg border border-line bg-sunken p-4 animate-enter">
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface py-1 pr-1 pl-3 font-mono text-mono">
        <span className="text-faint select-none">$</span>
        <span className="flex-1 text-ink">{command}</span>
        <CopyButton value={command} label="Copy install command" />
      </div>
      <p className="text-small text-muted">
        Vendors <span className="font-mono text-ink-2">{entry.files.map((f) => f.path).join(", ")}</span> into the project's components folder as owned code, pins it in <span className="font-mono text-ink-2">youi.lock</span>, and keeps it updatable from the design language.
      </p>
      {deps.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-small text-muted">
          Adds
          {deps.map((dep) => (
            <Badge key={dep} tone="outline" className="font-mono">
              {dep}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function ComponentPage({ model, entry, tab }: { model: Model; entry: ComponentEntry; tab: ElementTab }) {
  const { contract } = entry;
  const [, navigate] = useLocation();
  const [installing, setInstalling] = useState(false);
  const usage = useUsageState();
  const sites = usage.status === "ready" ? (usage.value.sitesByElement.get(contract.id) ?? []) : null;
  const summary = sites ? summarize(sites) : null;
  const name = parseId(contract.id)?.name ?? contract.name.toLowerCase();

  const selectTab = (next: string): void => {
    const href = elementHref(contract.id, next as ElementTab);
    markNavigation(href);
    navigate(href, { replace: true });
  };

  return (
    <article className="flex min-h-0 flex-1 flex-col animate-enter">
      <header className="shrink-0 px-6 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-2">
            <Box className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 data-detail-heading tabIndex={-1} className="truncate text-title outline-none">
                {contract.name}
              </h2>
              <StatusBadge status={contract.status} />
              <Badge tone="outline" className="tabular">
                v{contract.version}
              </Badge>
            </div>
            <div className="flex min-w-0 items-center gap-0.5 font-mono text-mono-sm text-muted">
              <span className="truncate">{contract.id}</span>
              <CopyButton value={contract.id} label="Copy element id" />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="ghost" asChild className="max-sm:hidden">
              <Link href="/changes">Propose change</Link>
            </Button>
            <Button variant="primary" aria-expanded={installing} onClick={() => setInstalling((open) => !open)}>
              <Download /> Install <ChevronDown className={installing ? "rotate-180 transition-transform" : "transition-transform"} />
            </Button>
          </div>
        </div>
        <p className="mt-3 max-w-2xl text-reading text-ink-2">{contract.summary}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-small text-muted">
          <span>
            Platforms <span className="text-ink-2">{contract.platforms.join(", ")}</span>
          </span>
          {contract.owners.length > 0 && (
            <span>
              Owners <span className="text-ink-2">{contract.owners.map((o) => o.replace(/^group:/, "")).join(", ")}</span>
            </span>
          )}
          <Link href={elementHref(contract.id, "where")} className="hover:text-ink">
            {summary ? (
              <span className="tabular">
                <span className="text-ink-2">{summary.sites}</span> sites · <span className="text-ink-2">{summary.screens}</span> screens · <span className="text-ink-2">{summary.projects}</span> {summary.projects === 1 ? "project" : "projects"}
              </span>
            ) : (
              "Usage loading…"
            )}
          </Link>
        </div>
        {installing && <InstallPanel entry={entry} />}
      </header>
      <Tabs value={tab} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label={`${contract.name} sections`}>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="contract" count={Object.keys(contract.props).length}>
            Contract
          </TabsTrigger>
          <TabsTrigger value="tokens" count={Object.keys(contract.tokens).length}>
            Tokens
          </TabsTrigger>
          <TabsTrigger value="rules" count={contract.rules.length}>
            Rules
          </TabsTrigger>
          <TabsTrigger value="where" count={summary?.sites}>
            Where it lives
          </TabsTrigger>
        </TabsList>
        <TabsContent value="preview" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <PreviewTab name={name} contract={contract} paper={{ light: stageFor(model, "light").background, dark: stageFor(model, "dark").background }} />
        </TabsContent>
        <TabsContent value="contract" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <ContractTab entry={entry} />
        </TabsContent>
        <TabsContent value="tokens" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <TokensTab model={model} contract={contract} />
        </TabsContent>
        <TabsContent value="rules" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <RulesTab model={model} contract={contract} />
        </TabsContent>
        <TabsContent value="where" className="flex min-h-0 flex-1 flex-col outline-none">
          <WhereTab contract={contract} usage={usage} />
        </TabsContent>
      </Tabs>
    </article>
  );
}
