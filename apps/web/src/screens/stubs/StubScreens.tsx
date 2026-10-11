/** Screens that come next: Rules, Sources, Changes and Access describe what they will hold. Also the not-found page. */
import { ClipboardCheck, Compass, Eye, FilePenLine, GitPullRequestArrow, KeyRound, Layers, Monitor, PlugZap, Replace, Rocket, Scale } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PaneHeader } from "../../ui/Pane.tsx";

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

export function RulesScreen() {
  return (
    <Planned
      title="Rules"
      icon={Scale}
      intro="Every rule in the System in one place: what it says, the instruction agents follow, how it is checked and where it is broken. Editing comes here next, with a draft, a preview of its impact and an approval before it applies."
      stages={[
        { icon: FilePenLine, title: "Draft", body: "Change a rule's statement, agent instruction, severity or check, saved as a draft that nothing reads yet." },
        { icon: Compass, title: "Preview impact", body: "Run the draft against live projects: new and resolved violations, file by file, before it applies." },
        { icon: ClipboardCheck, title: "Approve", body: "A person approves; agents and checks pick up the new rule on their next sync." },
      ]}
    />
  );
}

export function SourcesScreen() {
  return (
    <Planned
      title="Sources"
      icon={PlugZap}
      intro="Sources feed the Library: other design systems, UI kits and references. None are connected yet; each one will add its elements to the Library, where they are browsed and proposed but never built with."
      stages={[
        { icon: PlugZap, title: "Connect", body: "Point at a source; its elements are ingested with where they came from and when." },
        { icon: Layers, title: "Categorize", body: "Each element is filed by category and linked to the System elements it could replace." },
        { icon: Replace, title: "Propose a swap", body: "Request adoption; a person approves it into the System before anything is built with it." },
      ]}
    />
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
