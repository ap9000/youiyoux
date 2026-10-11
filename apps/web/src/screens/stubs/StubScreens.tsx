/**
 * Screens that come next. Screens already reads the usage map (a bill of materials
 * per route); Changes and Access describe what they will hold.
 */
import { ClipboardCheck, Compass, Eye, GitPullRequestArrow, KeyRound, Monitor, Rocket } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { elementHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { retryModel, retryUsage, useModelState, useUsageState } from "../../data/store.ts";
import { EVERY_SCREEN, screenBoms, type UsageIndex } from "../../data/usage.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader, ResourceState } from "../../ui/Pane.tsx";

function Planned({ title, icon, intro, stages }: { title: string; icon: LucideIcon; intro: string; stages: ReadonlyArray<{ icon: LucideIcon; title: string; body: string }> }) {
  const Icon = icon;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader title={title}>
        <Badge tone="outline">Next</Badge>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-8 py-12 animate-enter">
          <div className="space-y-3">
            <span className="grid size-9 place-items-center rounded-lg border border-line bg-raised text-muted">
              <Icon className="size-4" />
            </span>
            <p className="max-w-xl text-reading text-ink-2">{intro}</p>
          </div>
          <ol className="grid gap-3 md:grid-cols-3">
            {stages.map((stage, i) => (
              <li key={stage.title} className="space-y-2 rounded-lg border border-line p-4">
                <div className="flex items-center gap-2 text-small text-muted">
                  <stage.icon className="size-3.5" /> Step {i + 1}
                </div>
                <h3 className="text-heading">{stage.title}</h3>
                <p className="text-small text-muted">{stage.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

export function ChangesScreen() {
  return (
    <Planned
      title="Changes"
      icon={GitPullRequestArrow}
      intro="Every change to the design language becomes a typed change request: edit an element, see the blast radius before anything moves, then roll it out project by project with a visual review."
      stages={[
        { icon: Compass, title: "Plan", body: "Projects, sites and screens affected; which sites a codemod handles and which need a person; the version bump the change implies." },
        { icon: Rocket, title: "Rollout", body: "One pull request per project, gated on type check, lint, the contract invariants and approval, with a canary first." },
        { icon: Eye, title: "Visual review", body: "Before, after and diff for every affected screen, light and dark; expected changes accepted, unexpected ones stop the rollout." },
      ]}
    />
  );
}

export function AccessScreen() {
  return (
    <Planned
      title="Access"
      icon={KeyRound}
      intro="This hub runs locally with no accounts yet. Access arrives with the server: who can read or edit each system, who approves changes, and what agents may do."
      stages={[
        { icon: KeyRound, title: "Roles", body: "Viewer or editor per system or element, with approver as a separate grant. Agents can propose but never approve." },
        { icon: ClipboardCheck, title: "Audit", body: "Every grant, approval and rollout recorded, with “view as this person” to check what someone sees." },
        { icon: Monitor, title: "Projects", body: "Per-project install tokens for `youi add`, scoped to the systems that project uses." },
      ]}
    />
  );
}

export function ScreensScreen() {
  const model = useModelState();
  const usage = useUsageState();
  if (model.status !== "ready") return <ResourceState state={model} onRetry={retryModel} what="the catalog" />;
  if (usage.status !== "ready") return <ResourceState state={usage} onRetry={retryUsage} what="the usage map" />;
  return <ScreenList model={model.value} index={usage.value} />;
}

function ScreenList({ model, index }: { model: Model; index: UsageIndex }) {
  const boms = screenBoms(index);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader title="Screens" count={boms.length}>
        <span className="text-small text-muted max-sm:hidden">Thumbnails and violations per screen come with visual review</span>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="mx-auto grid max-w-5xl gap-3 p-6 md:grid-cols-2 animate-enter">
          {boms.map((bom) => {
            const elements = [...bom.elements].sort((a, b) => b[1] - a[1]);
            return (
              <li key={`${bom.project}:${bom.route}`} className="space-y-3 rounded-lg border border-line p-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-mono text-ink">{bom.route === EVERY_SCREEN ? "every screen" : bom.route}</span>
                  {bom.route === EVERY_SCREEN && <Badge tone="outline">app shell</Badge>}
                  <span className="ml-auto text-small text-muted">
                    {bom.project} · <span className="tabular">{bom.sites}</span> sites
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {elements.map(([id, count]) => (
                    <Link key={id} href={elementHref(id, "where")} className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-line px-2 text-small text-ink-2 hover:border-line-strong hover:text-ink">
                      {model.byId.get(id)?.name ?? id}
                      <span className="tabular text-caption text-muted">{count}</span>
                    </Link>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function NotFoundScreen() {
  return (
    <EmptyState
      icon={Compass}
      title="Nothing here"
      actions={
        <Button asChild>
          <Link href="/">Go home</Link>
        </Button>
      }
    >
      This address isn't a page in YouIyouX. Press ⌘K to jump to an element or screen.
    </EmptyState>
  );
}
