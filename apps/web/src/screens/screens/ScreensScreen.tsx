/**
 * Screens: every screen of every scanned project as a thumbnail with its element and
 * issue counts, or (`?view=canvas`) all of them on one board with their requests pinned;
 * `/screens/<project>/<screen>` opens one with its full screenshot.
 */
import { MonitorX } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import type { Model } from "../../data/model.ts";
import { type Screen, type ScreenIndex, screenHref, screensOf, routeLabel } from "../../data/screens.ts";
import { retryModel, retryUsage, useModelState, useUsageState } from "../../data/store.ts";
import type { ProjectShots } from "../../data/types.ts";
import { EVERY_SCREEN, type UsageIndex } from "../../data/usage.ts";
import { useRemote, workflowApi } from "../../data/workflow.ts";
import { useListKeys } from "../../shell/keyboard.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { Disclosure } from "../../ui/Disclosure.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, ResourceState } from "../../ui/Pane.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { ScreenImage } from "../../ui/ScreenImage.tsx";
import { IssueBadge, issueBreakdown } from "./IssueCounts.tsx";
import { ScreenDetail } from "./ScreenDetail.tsx";
import { ScreensCanvas } from "./ScreensCanvas.tsx";

const TOP_ELEMENTS = 3;
const SHORT_SHA = 7;

export function ScreensScreen() {
  const model = useModelState();
  const usage = useUsageState();
  if (model.status !== "ready") return <ResourceState state={model} onRetry={retryModel} what="the catalog" />;
  if (usage.status !== "ready") return <ResourceState state={usage} onRetry={retryUsage} what="the usage map" />;
  return <Screens model={model.value} index={usage.value} />;
}

function Screens({ model, index }: { model: Model; index: UsageIndex }) {
  const params = useParams<{ "*"?: string }>();
  const screens = screensOf(index, model.manifest);
  const rest = params["*"];
  if (!rest) return <ScreenGrid model={model} index={index} screens={screens} />;
  const screen = screens.byHref.get(`/screens/${rest}`);
  if (!screen) {
    return (
      <EmptyState
        icon={MonitorX}
        title="No such screen"
        actions={
          <Button asChild>
            <Link href="/screens">All screens</Link>
          </Button>
        }
      >
        No scanned project has a screen at <code className="font-mono text-mono-sm">{rest}</code>.
      </EmptyState>
    );
  }
  return <ScreenDetail key={rest} model={model} screens={screens} screen={screen} />;
}

function captureLine(shots: ProjectShots | undefined): string {
  return shots ? `Screenshots from the ${shots.source}, ${shots.capturedAt}` : "No screenshots captured for this project yet: youiyoux screens capture --base <url> takes them, with every component placed";
}

function ScreenGrid({ model, index, screens }: { model: Model; index: UsageIndex; screens: ScreenIndex }) {
  const { scheme } = useTheme();
  const [focused, setFocused] = useState(-1);
  const gridRef = useRef<HTMLDivElement>(null);
  const cards = (): HTMLAnchorElement[] => [...(gridRef.current?.querySelectorAll<HTMLAnchorElement>("[data-screen-card]") ?? [])];
  useListKeys({ count: screens.screens.length, index: focused, onMove: (i) => cards()[i]?.focus() });
  const projects = [...new Set(screens.screens.map((s) => s.project))];
  const [location, navigate] = useLocation();
  const canvas = new URLSearchParams(useSearch()).get("view") === "canvas";
  const requests = useRemote(workflowApi.requests, "requests");
  const header = (
    <PaneHeader title="Screens" count={screens.screens.length}>
      <Segmented<"grid" | "canvas"> label="Layout" value={canvas ? "canvas" : "grid"} onChange={(v) => navigate(v === "canvas" ? `${location}?view=canvas` : location, { replace: true })} options={[{ value: "grid", label: "Grid" }, { value: "canvas", label: "Canvas" }]} />
    </PaneHeader>
  );
  if (canvas)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        <ScreensCanvas screens={screens} scheme={scheme} requests={requests.state.status === "ready" ? requests.state.value.requests : []} />
      </div>
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header}
      <div ref={gridRef} data-list-pane onFocus={(event) => setFocused(cards().findIndex((card) => card === (event.target as Element)))} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-10 px-6 py-6 animate-enter max-sm:px-4">
          {projects.map((project) => {
            const commit = index.reports.find((r) => r.project === project)?.commit;
            const onProject = screens.screens.filter((s) => s.project === project);
            const pictured = onProject.some((s) => s.shot);
            return (
              <section key={project} aria-labelledby={`screens-${project}`} className="space-y-4">
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 id={`screens-${project}`} className="text-heading">
                    {project}
                  </h2>
                  {commit && <span className="font-mono text-mono-sm text-muted">@{commit.slice(0, SHORT_SHA)}</span>}
                  <span className="text-small text-muted">{captureLine(screens.shots.get(project))}</span>
                </header>
                <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {onProject.map((screen) => (
                    <li key={screen.route}>
                      <ScreenCard model={model} screen={screen} scheme={scheme} pictured={pictured} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {screens.unattributedFiles.length > 0 && (
            <Disclosure
              className="max-w-2xl text-small text-muted"
              summaryClassName="min-h-11 rounded-sm py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              summary={<span>Not on any screen · {screens.unattributedFiles.length} {screens.unattributedFiles.length === 1 ? "file" : "files"}</span>}
            >
              {screens.unattributed.total > 0 && <p className="mt-1">{issueBreakdown(screens.unattributed).join(", ")}</p>}
              <ul className="mt-3 space-y-3">
                {screens.unattributedFiles.map(({ project, file, sites, reason }) => (
                  <li key={`${project}:${file}`}>
                    <code className="font-mono text-mono-sm break-all text-ink-2">{project}/{file}</code>
                    {sites > 0 && <span className="ml-2 inline-block">{sites} {sites === 1 ? "site" : "sites"}</span>}
                    <p className="break-words">{reason}</p>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      </div>
    </div>
  );
}

/** `pictured`: whether any screen of the project has a picture; when none does, the cards are text only. */
function ScreenCard({ model, screen, scheme, pictured }: { model: Model; screen: Screen; scheme: Scheme; pictured: boolean }) {
  const rendered = screen.elements.filter((e) => e.sites.length > 0);
  const top = rendered.slice(0, TOP_ELEMENTS);
  const more = rendered.length - top.length;
  return (
    <Link
      href={screenHref(screen.project, screen.route)}
      data-screen-card
      className="group block h-full overflow-hidden rounded-lg border border-line bg-surface transition-colors duration-100 hover:border-line-strong hover:bg-raised"
    >
      <ScreenImage shot={screen.shot} scheme={scheme} size="thumb" label={`${screen.project} ${routeLabel(screen.route)}`} whenMissing={pictured ? "placeholder" : "none"} className="border-b border-line" />
      <div className="space-y-1 px-3.5 pt-2.5 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-mono text-ink">{screen.route === EVERY_SCREEN ? "every screen" : screen.route}</span>
          {screen.route === EVERY_SCREEN && <Badge tone="outline">app shell</Badge>}
          <span className="ml-auto">
            <IssueBadge issues={screen.issues} />
          </span>
        </div>
        <p className="truncate text-small text-muted">
          <span className="tabular">
            {rendered.length} {rendered.length === 1 ? "element" : "elements"} · {screen.sites} {screen.sites === 1 ? "site" : "sites"}
          </span>
          {top.length > 0 && <span className="text-faint"> — </span>}
          {top.map((e, i) => (
            <span key={e.id} className="text-ink-2">
              {i > 0 && ", "}
              {model.byId.get(e.id)?.name ?? e.id}
            </span>
          ))}
          {more > 0 && <span> +{more}</span>}
        </p>
      </div>
    </Link>
  );
}
