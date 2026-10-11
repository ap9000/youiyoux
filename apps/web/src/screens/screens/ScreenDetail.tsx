/**
 * One screen: its full screenshot, the elements it renders (grouped by element, with
 * their near-misses) and the rule issues in its files. j/k step to the next screen.
 */
import { clsx } from "clsx";
import { ArrowUpRight, ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import { elementHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { type Screen, type ScreenElement, type ScreenIndex, screenHref, routeLabel } from "../../data/screens.ts";
import { EVERY_SCREEN, type ProjectViolation } from "../../data/usage.ts";
import { markNavigation } from "../../lib/perf.ts";
import { useListKeys } from "../../shell/keyboard.ts";
import { Badge, SeverityBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { KindIcon } from "../../ui/KindIcon.tsx";
import { PaneHeader } from "../../ui/Pane.tsx";
import { ScreenImage, shotFile, shotUrl } from "../../ui/ScreenImage.tsx";
import { Section } from "../../ui/Section.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { Capped, choiceProps, SiteLocation, SiteRow } from "../element/sites.tsx";
import { IssueBadge, issueBreakdown } from "./IssueCounts.tsx";

/** A collapsible group: native details/summary, so it is keyboard- and reader-friendly for free. */
function Group({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group/details border-b border-line last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-raised [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-faint transition-transform duration-100 group-open/details:rotate-90" />
        {summary}
      </summary>
      <ul className="pb-1.5">{children}</ul>
    </details>
  );
}

function ElementGroup({ model, element, scheme }: { model: Model; element: ScreenElement; scheme: Scheme }) {
  const summary = model.byId.get(element.id);
  const contract = model.components.get(element.id)?.contract;
  const choices = choiceProps(contract);
  const name = summary?.name ?? element.id;
  return (
    <Group
      summary={
        <>
          {summary && <KindIcon element={summary} scheme={scheme} />}
          <span className="font-medium text-ink">{name}</span>
          <span className="tabular text-small text-muted">{element.sites.length}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {element.lookalikes.length > 0 && (
              <Badge tone="warning" className="tabular" title="Local components named like this element that resolve elsewhere">
                {element.lookalikes.length} lookalike{element.lookalikes.length === 1 ? "" : "s"}
              </Badge>
            )}
            {element.unresolved.length > 0 && (
              <Badge tone="outline" className="tabular" title="Sites the scanner could not resolve that might be this element">
                {element.unresolved.length} unresolved
              </Badge>
            )}
            <Link href={elementHref(element.id, "usage")} className="grid size-5 place-items-center rounded-xs text-muted hover:bg-neutral-soft hover:text-ink" aria-label={`${name}: usage everywhere`} title={`${name}: usage everywhere`}>
              <ArrowUpRight className="size-3.5" />
            </Link>
          </span>
        </>
      }
    >
      <Capped items={element.sites} render={(site) => <SiteRow key={`${site.fingerprint}:${site.line}:${site.column}`} site={site} choices={choices} contract={contract} />} />
      {element.lookalikes.map((l) => (
        <li key={`l:${l.file}:${l.line}:${l.column}`} className="flex min-w-0 items-center gap-3 px-3 py-1.5">
          <SiteLocation site={l} className="w-[min(18rem,40%)] shrink-0" />
          <span className="min-w-0 text-small text-muted">
            <Badge tone="warning">lookalike</Badge> <code className="font-mono text-mono-sm text-ink-2">&lt;{l.local}&gt;</code> is <code title={l.resolved} className="font-mono text-mono-sm">{l.resolved.split("/").pop()}</code>
          </span>
        </li>
      ))}
      {element.unresolved.map((u) => (
        <li key={`u:${u.file}:${u.line}:${u.column}`} className="flex min-w-0 items-center gap-3 px-3 py-1.5">
          <SiteLocation site={u} className="w-[min(18rem,40%)] shrink-0" />
          <span className="min-w-0 text-small text-muted">
            <Badge tone="outline">unresolved</Badge> {u.detail}
          </span>
        </li>
      ))}
    </Group>
  );
}

function ViolationRow({ violation }: { violation: ProjectViolation }) {
  return (
    <li className="px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-3">
        <SiteLocation site={violation} className="w-[min(18rem,40%)] shrink-0" />
        <code className="min-w-0 rounded-xs bg-neutral-soft px-1 font-mono text-mono-sm break-all text-ink-2">{violation.text}</code>
      </div>
      {violation.suggestion && <p className="mt-0.5 text-small text-muted">Use {violation.suggestion}</p>}
    </li>
  );
}

function IssueGroups({ model, screen }: { model: Model; screen: Screen }) {
  const byRule = new Map<string, ProjectViolation[]>();
  for (const v of screen.violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
  const rules = [...byRule].sort(([, a], [, b]) => b.length - a.length);
  if (rules.length === 0) return <p className="rounded-md border border-line px-3 py-4 text-small text-muted">No rule is broken in this screen's files.</p>;
  return (
    <div className="rounded-md border border-line">
      {rules.map(([id, list]) => {
        const rule = model.rules.get(id);
        return (
          <Group
            key={id}
            summary={
              <>
                <SeverityBadge severity={list[0]!.severity} />
                <span className="min-w-0 truncate font-medium text-ink">{rule?.title ?? id}</span>
                <span className="ml-auto tabular text-small text-muted">{list.length}</span>
              </>
            }
          >
            {rule && (
              <li className="px-3 pb-1.5 text-small text-muted">
                {rule.statement}{" "}
                <Link href={elementHref(id)} className="text-accent hover:underline">
                  Open the rule
                </Link>
              </li>
            )}
            <Capped items={list} render={(v) => <ViolationRow key={`${v.file}:${v.line}:${v.column}`} violation={v} />} />
          </Group>
        );
      })}
    </div>
  );
}

/** j/k (and arrows) step through the screens in grid order. */
function useStepKeys(screens: ScreenIndex, screen: Screen): { previous: Screen | undefined; next: Screen | undefined } {
  const [, navigate] = useLocation();
  const list = screens.screens;
  const index = list.indexOf(screen);
  useListKeys({
    count: list.length,
    index,
    onMove: (i) => {
      const target = list[i];
      if (!target) return;
      const href = screenHref(target.project, target.route);
      markNavigation(href);
      navigate(href);
    },
  });
  return { previous: list[index - 1], next: list[index + 1] };
}

function StepLink({ target, label, children }: { target: Screen | undefined; label: string; children: ReactNode }) {
  if (!target) {
    return (
      <Button variant="ghost" size="icon" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="icon" asChild>
      <Link href={screenHref(target.project, target.route)} aria-label={`${label}: ${routeLabel(target.route)}`} title={`${label} (${label.startsWith("Next") ? "j" : "k"})`}>
        {children}
      </Link>
    </Button>
  );
}

export function ScreenDetail({ model, screens, screen }: { model: Model; screens: ScreenIndex; screen: Screen }) {
  const { scheme: hubScheme } = useTheme();
  const [scheme, setScheme] = useState<Scheme>(hubScheme);
  const { previous, next } = useStepKeys(screens, screen);
  const shots = screens.shots.get(screen.project);
  const full = shotFile(screen.shot, scheme, "full");
  const ratio = shots ? shots.viewport.width / shots.viewport.height : undefined;
  const label = routeLabel(screen.route);
  const rendered = screen.elements.filter((e) => e.sites.length > 0).length;
  const breakdown = issueBreakdown(screen.issues);
  const image = <ScreenImage shot={screen.shot} scheme={scheme} size="full" label={`${screen.project} ${label}`} {...(ratio ? { ratio } : {})} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title={
          <span className="flex items-center gap-1.5">
            <Link href="/screens" className="text-muted hover:text-ink">
              Screens
            </Link>
            <span className="text-faint">/</span>
            <span className="font-mono text-mono">{screen.route === EVERY_SCREEN ? "every screen" : screen.route}</span>
          </span>
        }
      >
        <Segmented<Scheme> label="Screenshot scheme" value={scheme} onChange={setScheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} className="max-sm:hidden" />
        <StepLink target={previous} label="Previous screen">
          <ChevronLeft />
        </StepLink>
        <StepLink target={next} label="Next screen">
          <ChevronRight />
        </StepLink>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 animate-enter max-xl:flex-col max-xl:overflow-y-auto">
        <div className="min-w-0 flex-1 xl:overflow-y-auto">
          <figure className="space-y-2.5 p-6 max-sm:p-4">
            <div className={clsx("overflow-hidden rounded-lg border border-line shadow-raise", !full && "border-dashed shadow-none")}>
              {full ? (
                <a href={shotUrl(full.file)} target="_blank" rel="noreferrer" title="Open full size" className="block">
                  {image}
                </a>
              ) : (
                image
              )}
            </div>
            <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
              {screen.shot && (
                <span>
                  Captured at <code className="font-mono text-mono-sm text-ink-2">{screen.shot.path}</code>
                  {screen.shot.note && <> · {screen.shot.note}</>}
                </span>
              )}
              {shots && (
                <span className="text-faint">
                  {shots.source}, {shots.capturedAt}
                </span>
              )}
            </figcaption>
          </figure>
        </div>

        <aside aria-label={`What ${label} is made of`} className="space-y-6 border-line p-6 max-sm:p-4 xl:w-[440px] xl:shrink-0 xl:overflow-y-auto xl:border-l xl:pl-5">
          <div className="space-y-2">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
              <span className="tabular">
                <span className="text-heading text-ink">{rendered}</span> elements · <span className="text-ink-2">{screen.sites}</span> sites
              </span>
              <IssueBadge issues={screen.issues} />
            </p>
            {breakdown.length > 0 && <p className="tabular text-small text-muted">{breakdown.join(" · ")}, counted from the files that render on this screen.</p>}
          </div>
          <Section title="Elements" count={screen.elements.length}>
            <div className="rounded-md border border-line">
              {screen.elements.map((element) => (
                <ElementGroup key={element.id} model={model} element={element} scheme={hubScheme} />
              ))}
            </div>
          </Section>
          <Section title="Rule issues" count={screen.violations.length}>
            <IssueGroups model={model} screen={screen} />
          </Section>
        </aside>
      </div>
    </div>
  );
}
