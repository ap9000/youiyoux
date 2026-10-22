/**
 * One screen: its full screenshot, the elements it renders (grouped by element, with
 * their near-misses) and the rule issues in its files. j/k step to the next screen.
 * When the capture placed its components (`youiyoux screens capture`), they are on the
 * picture (PlacesOverlay): pointed at, picked out, and linked from the element list.
 */
import { clsx } from "clsx";
import { ArrowUpRight, ChevronLeft, ChevronRight, Crosshair, MessageSquarePlus, X } from "lucide-react";
import type { RequestDoc, RequestTarget } from "@youiyoux/core";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import { elementHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { elementOf, isSelected, matchPlaces, usePlaces, type Placed } from "../../data/places.ts";
import { useRemote, workflowApi } from "../../data/workflow.ts";
import { type Screen, type ScreenElement, type ScreenIndex, screenHref, routeLabel } from "../../data/screens.ts";
import { EVERY_SCREEN, type ProjectViolation } from "../../data/usage.ts";
import { markNavigation } from "../../lib/perf.ts";
import { useListKeys } from "../../shell/keyboard.ts";
import { Badge, SeverityBadge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { KindIcon } from "../../ui/KindIcon.tsx";
import { PaneHeader } from "../../ui/Pane.tsx";
import { ScreenImage, shotFile, shotUrl } from "../../ui/ScreenImage.tsx";
import { Section } from "../../ui/Section.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { Capped, choiceProps, SiteLocation, SiteRow } from "../element/sites.tsx";
import { IssueBadge, issueBreakdown } from "./IssueCounts.tsx";
import { type Outline, type Pin, PlacesOverlay } from "./PlacesOverlay.tsx";
import { RequestComposer, RequestThread } from "./Requests.tsx";

/** A collapsible group: native details/summary, so it is keyboard- and reader-friendly for free. */
function Group({ summary, children, open, onPoint }: { summary: ReactNode; children: ReactNode; open?: boolean; onPoint?: (pointed: boolean) => void }) {
  return (
    <details open={open} className="group/details border-b border-line last:border-b-0" onPointerEnter={onPoint && (() => onPoint(true))} onPointerLeave={onPoint && (() => onPoint(false))}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-raised [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-faint transition-transform duration-100 group-open/details:rotate-90" />
        {summary}
      </summary>
      <ul className="pb-1.5">{children}</ul>
    </details>
  );
}

interface OnPicture {
  /** How many boxes it has on the picture. */
  readonly count: number;
  readonly locate: () => void;
  readonly point: (pointed: boolean) => void;
}

function ElementGroup({ model, element, scheme, picture }: { model: Model; element: ScreenElement; scheme: Scheme; picture?: OnPicture }) {
  const summary = model.byId.get(element.id);
  const contract = model.components.get(element.id)?.contract;
  const choices = choiceProps(contract);
  const name = summary?.name ?? element.id;
  return (
    <Group
      {...(picture ? { onPoint: picture.point } : {})}
      summary={
        <>
          {summary && <KindIcon element={summary} scheme={scheme} />}
          <span className="font-medium text-ink">{name}</span>
          {element.sites.length > 0 && <span className="tabular text-small text-muted">{element.sites.length}</span>}
          <span className="ml-auto flex items-center gap-1.5">
            {picture && picture.count > 0 && (
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  picture.locate();
                }}
                onFocus={() => picture.point(true)}
                onBlur={() => picture.point(false)}
                className="inline-flex h-5 items-center gap-1 rounded-xs px-1 text-caption text-muted hover:bg-neutral-soft hover:text-ink"
                aria-label={`Show ${name} on the screenshot (${picture.count})`}
                title="Show on the screenshot"
                data-locate={element.id}
              >
                <Crosshair aria-hidden className="size-3.5" />
                <span className="tabular">{picture.count}</span>
              </button>
            )}
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

/** What is picked on the picture: its name and kind, the line that rendered it and where to go from it. */
function Selection({ placed, all, name, copies, onClear, onComment }: { placed: Placed; all: readonly Placed[]; name: string; copies: string | null; onClear: () => void; onComment: () => void }) {
  const { place, element, lookalike, at } = placed;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2.5" data-selection={element ?? at ?? place.name}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-ink">{name}</span>
          <Badge tone={element ? "accent" : lookalike ? "warning" : "outline"}>{element ? "System element" : lookalike ? `Lookalike of ${copies ?? lookalike}` : "Component"}</Badge>
          {all.length > 1 && <span className="tabular text-small text-muted">{all.length} on this screen</span>}
        </p>
        <p className="truncate font-mono text-mono-sm text-muted">
          {at ?? "its line is unknown (a library's own part, or a production build)"}
          {place.owner && <span className="text-faint"> · in {place.owner}</span>}
        </p>
      </div>
      <span className="flex items-center gap-1">
        <Button size="sm" variant="primary" onClick={onComment} data-comment>
          <MessageSquarePlus /> Request
        </Button>
        {at && <CopyButton value={at} label={`Copy ${at}`} />}
        {(element ?? lookalike) && (
          <Button size="sm" variant="outline" asChild>
            <Link href={elementHref((element ?? lookalike)!, "usage")}>{lookalike ? "Open the element it copies" : "Open element"}</Link>
          </Button>
        )}
        <Button size="icon" variant="ghost" onClick={onClear} aria-label="Clear the selection" title="Clear">
          <X />
        </Button>
      </span>
    </div>
  );
}

export function ScreenDetail({ model, screens, screen }: { model: Model; screens: ScreenIndex; screen: Screen }) {
  const { scheme: hubScheme } = useTheme();
  const [scheme, setScheme] = useState<Scheme>(hubScheme);
  const { previous, next } = useStepKeys(screens, screen);
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const select = params.get("select");
  const active = params.get("request");
  // The pick and the open request live in the address, so either can be linked to.
  const go = (next: { select?: string | null; request?: string | null }): void => {
    const query = new URLSearchParams();
    const value = { select, request: active, ...next };
    if (value.select) query.set("select", value.select);
    if (value.request) query.set("request", value.request);
    navigate(`${location}${query.size ? `?${query.toString()}` : ""}`, { replace: true });
  };
  const setSelect = (value: string | null): void => go({ select: value, request: null });
  const [composing, setComposing] = useState(false);
  const requests = useRemote(workflowApi.requests, "requests");
  const placesState = usePlaces(screen.shot?.places);
  const places = placesState?.status === "ready" ? placesState.value : null;
  // A place names its own file and line, so it is matched against every site of the project, not
  // only this route's: the app shell's picture shows a page's content too.
  const placed = useMemo(() => {
    if (!places) return [];
    const project = screens.screens.filter((s) => s.project === screen.project);
    return matchPlaces(places.places, project.flatMap((s) => s.elements.flatMap((e) => e.sites)), project.flatMap((s) => s.lookalikes));
  }, [places, screen, screens]);
  const anyElement = placed.some((p) => elementOf(p) !== null);
  const [outlineChoice, setOutline] = useState<Outline | null>(null);
  const outline: Outline = outlineChoice ?? (anyElement ? "elements" : "all");
  const [pointed, setPointed] = useState<string | null>(null);
  const nameOf = (p: Placed): string => (p.element ? (model.byId.get(p.element)?.name ?? p.element) : p.place.name);
  const picked = placed.filter((p) => isSelected(p, select));
  // This screen's requests: those filed on it, and those for every use of an element placed on it; numbered oldest first.
  const all = requests.state.status === "ready" ? requests.state.value.requests : [];
  const placedElements = new Set(placed.map(elementOf).filter((e): e is string => e !== null));
  const onScreen = all.filter((r) => r.target.route === screen.route || (r.target.scope === "element" && r.target.element !== undefined && placedElements.has(r.target.element))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const replace = (next: RequestDoc): void => {
    if (requests.state.status !== "ready") return requests.reload();
    const list = requests.state.value.requests;
    requests.set({ ...requests.state.value, requests: list.some((r) => r.id === next.id) ? list.map((r) => (r.id === next.id ? next : r)) : [next, ...list] });
  };
  const pinOf = (request: RequestDoc, number: number): Pin | null => {
    const at = request.target.route === screen.route && request.target.box ? request.target.box : placed.find((p) => request.target.element && elementOf(p) === request.target.element)?.place.box;
    return at ? { id: request.id, number, box: { x: at.x, y: at.y }, status: request.status } : null;
  };
  const pins = onScreen.map((r, i) => pinOf(r, i + 1)).filter((p): p is Pin => p !== null);
  const openRequest = (request: RequestDoc): void => {
    const t = request.target;
    go({ request: request.id, select: t.scope === "element" && t.element ? t.element : t.file && t.line ? `${t.file}:${t.line}` : (t.element ?? null) });
  };
  const targetOf = (p: Placed): RequestTarget => ({
    route: screen.route,
    scope: "here",
    name: p.place.name,
    ...(elementOf(p) ? { element: elementOf(p)! } : {}),
    ...(p.lookalike ? { lookalike: true } : {}),
    ...(p.place.file ? { file: p.place.file } : {}),
    ...(p.place.line ? { line: p.place.line } : {}),
    box: p.place.box,
    ...(places ? { page: places.size } : {}),
  });

  const picture = (id: string): OnPicture | undefined => {
    if (!places) return undefined;
    const count = placed.filter((p) => elementOf(p) === id).length;
    return { count, locate: () => setSelect(id), point: (on) => setPointed(on ? id : null) };
  };
  const shots = screens.shots.get(screen.project);
  const full = shotFile(screen.shot, scheme, "full");
  const ratio = shots ? shots.viewport.width / shots.viewport.height : undefined;
  const label = routeLabel(screen.route);
  const rendered = screen.elements.filter((e) => e.sites.length > 0);
  const suspected = screen.elements.filter((e) => e.sites.length === 0);
  const breakdown = issueBreakdown(screen.issues);
  const image = places ? (
    <PlacesOverlay shot={screen.shot} scheme={scheme} label={`${screen.project} ${label}`} places={places} placed={placed} outline={outline} select={select} pointed={pointed} nameOf={nameOf} onSelect={(p) => setSelect(p ? (p.element ?? p.at) : null)} pins={pins} activePin={active} onPin={(id) => { const r = onScreen.find((x) => x.id === id); if (r) openRequest(r); }} />
  ) : (
    <ScreenImage shot={screen.shot} scheme={scheme} size="full" label={`${screen.project} ${label}`} {...(ratio ? { ratio } : {})} />
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
        {places && <Segmented<Outline> label="Outline on the screenshot" value={outline} onChange={setOutline} options={[{ value: "elements", label: "Elements" }, { value: "all", label: "All" }, { value: "off", label: "Off" }]} className="max-sm:hidden" />}
        <Segmented<Scheme> label="Screenshot scheme" value={scheme} onChange={setScheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} className="max-sm:hidden" />
        <StepLink target={previous} label="Previous screen">
          <ChevronLeft />
        </StepLink>
        <StepLink target={next} label="Next screen">
          <ChevronRight />
        </StepLink>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 animate-enter max-xl:flex-col max-xl:overflow-y-auto">
        <div className="min-w-0 xl:flex-1 xl:overflow-y-auto">
          <figure className="space-y-2.5 p-6 max-sm:p-4">
            {places && (picked[0] ? (
              <>
                <Selection placed={picked[0]} all={picked} name={nameOf(picked[0])} copies={picked[0].lookalike ? (model.byId.get(picked[0].lookalike)?.name ?? null) : null} onClear={() => setSelect(null)} onComment={() => setComposing(true)} />
                {composing && (
                  <RequestComposer
                    key={picked[0].at ?? picked[0].place.name}
                    target={targetOf(picked[0])}
                    elementName={elementOf(picked[0]) ? (model.byId.get(elementOf(picked[0])!)?.name ?? null) : null}
                    onCancel={() => setComposing(false)}
                    onFiled={(request) => {
                      replace(request);
                      setComposing(false);
                      go({ request: request.id });
                    }}
                  />
                )}
              </>
            ) : (
              <p className="text-small text-muted" data-places-hint>
                Point at the screenshot to name a component; click to pick it out. <span className="tabular">{placed.length}</span> components placed: <span className="tabular">{placed.filter((p) => p.element).length}</span> System elements, <span className="tabular">{placed.filter((p) => p.lookalike).length}</span> lookalikes
                {places.dev ? "." : ", without their lines: the capture was of a production build."}
              </p>
            ))}
            <div className={clsx("overflow-hidden rounded-lg border border-line shadow-raise", !full && "border-dashed shadow-none")}>
              {full && !places ? (
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
                  Captured at <code className="font-mono text-mono-sm break-all text-ink-2">{screen.shot.path}</code>
                  {screen.shot.note && <> · {screen.shot.note}</>}
                </span>
              )}
              {shots && (
                <span className="text-faint">
                  {shots.source}, {shots.capturedAt}
                </span>
              )}
              {full && places && (
                <a href={shotUrl(full.file)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  Open full size
                </a>
              )}
            </figcaption>
          </figure>
        </div>

        <aside aria-label={`What ${label} is made of`} className="space-y-6 border-line p-6 max-sm:p-4 xl:w-[440px] xl:shrink-0 xl:overflow-y-auto xl:border-l xl:pl-5">
          <div className="space-y-2">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
              <span className="tabular">
                <span className="text-heading text-ink">{rendered.length}</span> elements · <span className="text-ink-2">{screen.sites}</span> sites
              </span>
              <IssueBadge issues={screen.issues} />
            </p>
            {breakdown.length > 0 && <p className="tabular text-small text-muted">{breakdown.join(" · ")}, counted from the files that render on this screen.</p>}
          </div>
          {(onScreen.length > 0 || requests.state.status === "error") && (
            <Section title="Requests" count={onScreen.filter((r) => r.status !== "closed").length}>
              {requests.state.status === "error" ? (
                <p className="text-small text-muted" data-requests-offline>
                  {requests.state.error.offline ? "Requests on this screen need the local service: open the hub with youiyoux ui --project." : requests.state.error.message}
                </p>
              ) : (
                <ol className="space-y-2" aria-label="Requests on this screen">
                  {onScreen.map((request, i) => (
                    <RequestThread key={request.id} request={request} number={i + 1} active={active === request.id} onChange={replace} onPick={() => openRequest(request)} />
                  ))}
                </ol>
              )}
            </Section>
          )}
          <Section title="Elements" count={rendered.length}>
            <div className="rounded-md border border-line">
              {rendered.map((element) => (
                <ElementGroup key={element.id} model={model} element={element} scheme={hubScheme} picture={picture(element.id)} />
              ))}
            </div>
          </Section>
          {suspected.length > 0 && (
            <Section title="Only lookalikes or unresolved" count={suspected.length}>
              <div className="rounded-md border border-line">
                {suspected.map((element) => (
                  <ElementGroup key={element.id} model={model} element={element} scheme={hubScheme} picture={picture(element.id)} />
                ))}
              </div>
            </Section>
          )}
          <Section title="Rule issues" count={screen.violations.length}>
            <IssueGroups model={model} screen={screen} />
          </Section>
        </aside>
      </div>
    </div>
  );
}
