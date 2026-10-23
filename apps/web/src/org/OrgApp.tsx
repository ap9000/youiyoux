/**
 * The hosted hub (`youiyoux hub serve`): the organisation, read-only. Every repository's latest
 * record from CI, and each System's adoption by the version its products have synced. index.html
 * names the API with the `youi-org` meta tag; the snapshot the local hub reads is never loaded.
 * Nothing here changes a repository: approval stays in the design repo's pull requests.
 */
import type { OrgView, ProjectStatus, ProjectStatusFailure } from "@youiyoux/core";
import { Building2, LogOut, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { OrgRequestError, orgApi } from "../data/org.ts";
import { when } from "../lib/when.ts";
import { noun, plural } from "../lib/plural.ts";
import { Facts, Next } from "../screens/workspace/WorkspaceScreen.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Field, TextInput } from "../ui/Field.tsx";
import { PaneHeader, PaneSkeleton } from "../ui/Pane.tsx";

type Load = { state: "loading" } | { state: "signed-out" } | { state: "failed"; message: string } | { state: "ready"; view: OrgView };
type System = OrgView["systems"][number];

const mono = "font-mono text-mono-sm";
const failed = (p: ProjectStatus | ProjectStatusFailure): p is ProjectStatusFailure => "error" in p;

/** The accent for the newest version, then steps of it toward the surface; never synced is a plain line. */
function shade(system: System, version: string | null, index: number): string {
  if (version === null) return "var(--color-line-strong)";
  if (version === system.latest) return "var(--color-accent)";
  return `color-mix(in srgb, var(--color-accent) ${index <= 1 ? 55 : 25}%, var(--color-surface))`;
}

function Adoption({ system }: { system: System }) {
  const total = system.versions.reduce((n, v) => n + v.products.length, 0);
  const onLatest = system.versions.find((v) => v.version === system.latest)?.products.length ?? 0;
  return (
    <section className="space-y-3" aria-label={`${system.name} adoption`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-body font-medium text-ink">{system.name}</h3>
        <span className={`${mono} text-muted`}>{system.id}</span>
        <span className="tabular text-small text-ink-2">
          {onLatest} of {plural(total, "product")} on the newest, <span className={`${mono} text-ink`}>v{system.latest}</span>
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-raised" role="img" aria-label={system.versions.map((v) => `${v.version ? `v${v.version}` : "never synced"}: ${v.products.length}`).join(", ")}>
        {system.versions.map((v, i) => (
          <span key={v.version ?? "never"} className="h-full border-r border-surface last:border-r-0" style={{ width: `${(v.products.length / total) * 100}%`, background: shade(system, v.version, i) }} />
        ))}
      </div>
      <ul className="space-y-1">
        {system.versions.map((v, i) => (
          <li key={v.version ?? "never"} className="grid grid-cols-[auto_6rem_3rem_minmax(0,1fr)] items-baseline gap-3 text-small max-sm:grid-cols-[auto_5rem_2.5rem_minmax(0,1fr)]">
            <span className="size-2 translate-y-[-1px] rounded-full" style={{ background: shade(system, v.version, i) }} aria-hidden />
            <span className={v.version ? `${mono} text-ink` : "text-muted"}>{v.version ? `v${v.version}` : "never synced"}</span>
            <span className="tabular text-ink-2">{v.products.length}</span>
            <span className="truncate text-muted">{v.products.map((p) => `${p.repo} · ${p.id}`).join(", ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Product({ entry, latest }: { entry: ProjectStatus | ProjectStatusFailure; latest: Map<string, string> }) {
  if (failed(entry)) {
    return (
      <li className="space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`${mono} text-ink`}>{entry.root}</span>
          <Badge tone="danger">Could not be read</Badge>
        </div>
        <p className="text-small text-ink-2">{entry.error}</p>
        <Next next={entry.next} />
      </li>
    );
  }
  const newest = latest.get(entry.system.id);
  const synced = entry.lock?.systemVersion ?? null;
  return (
    <li className="space-y-2 px-4 py-3" data-product={entry.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-body font-medium text-ink">{entry.id}</span>
        {entry.root !== "." && entry.root !== entry.id && <span className={`${mono} text-muted`}>{entry.root}</span>}
        {synced !== null && synced !== newest && <Badge tone="warning">Synced v{synced}; v{newest} is out</Badge>}
      </div>
      <Facts status={entry} />
      <Next next={entry.next} />
    </li>
  );
}

function Repository({ repo, latest }: { repo: OrgView["repos"][number]; latest: Map<string, string> }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line" aria-label={repo.repo}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line bg-raised px-4 py-2">
        <h3 className={`${mono} text-ink`}>{repo.repo}</h3>
        <span className="text-small text-muted">
          {repo.commit && <span className={mono}>{repo.commit.slice(0, 7)}</span>}
          {repo.ref && <> on {repo.ref}</>} · recorded {when(repo.generatedAt)}
        </span>
      </header>
      <ul className="divide-y divide-line">
        {repo.products.map((entry) => (
          <Product key={failed(entry) ? entry.root : entry.id} entry={entry} latest={latest} />
        ))}
      </ul>
    </section>
  );
}

function Headline({ view }: { view: OrgView }) {
  const { totals } = view;
  const readable = totals.products - totals.unreadable;
  return (
    <div className="space-y-2">
      <p className="max-w-3xl text-title text-ink-2">
        <span className="tabular text-ink">{plural(totals.products, "product")}</span> in <span className="tabular text-ink">{plural(totals.repos, "repository", "repositories")}</span> follow <span className="tabular text-ink">{plural(view.systems.length, "System")}</span>.{" "}
        {readable > 0 && (
          <>
            <span className="tabular text-ink">{totals.behind}</span> {totals.behind === 1 ? "is" : "are"} behind {noun(totals.behind, "its", "their")} System's newest release, and <span className={`tabular ${totals.failing > 0 ? "text-danger" : "text-ink"}`}>{totals.failing}</span> {totals.failing === 1 ? "fails its" : "fail their"} check.
          </>
        )}
        {totals.unreadable > 0 && <span className="text-danger"> {plural(totals.unreadable, "product")} could not be read.</span>}
      </p>
      <p className="text-small text-muted">As CI last recorded each repository (youiyoux record). Read {when(view.generatedAt)}.</p>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    orgApi.signIn(key).then(
      () => onSignedIn(),
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setBusy(false);
      },
    );
  };
  return (
    <div className="flex flex-1 items-center justify-center p-8 max-sm:p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 animate-enter">
        <div className="space-y-1.5">
          <h2 className="text-heading">Sign in to the hub</h2>
          <p className="text-small text-muted">Where each product stands with its design system, as CI records it. Whoever runs this hub has its view key.</p>
        </div>
        <Field label="View key" error={error}>
          {(id, describedBy) => <TextInput id={id} type="password" autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)} aria-describedby={describedBy} aria-invalid={error ? true : undefined} required autoFocus />}
        </Field>
        <Button type="submit" variant="primary" disabled={busy || key.length === 0} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

function NoRecords() {
  return (
    <EmptyState icon={Building2} title="No records yet">
      <p>
        In each repository, <span className={`${mono} text-ink`}>youiyoux hooks install --record</span> writes a workflow that sends its record here on every push to the default branch. Set <span className={`${mono} text-ink`}>YOUIYOUX_HUB_URL</span> and <span className={`${mono} text-ink`}>YOUIYOUX_HUB_TOKEN</span> as its secrets.
      </p>
    </EmptyState>
  );
}

export function OrgApp({ api }: { api: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const read = useCallback(() => {
    orgApi.view(api).then(
      (view) => setLoad({ state: "ready", view }),
      (error: unknown) => setLoad(error instanceof OrgRequestError && error.status === 401 ? { state: "signed-out" } : { state: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
  }, [api]);
  useEffect(read, [read]);
  const signOut = (): void => void orgApi.signOut().finally(() => setLoad({ state: "signed-out" }));
  const view = load.state === "ready" ? load.view : null;
  const latest = new Map(view?.systems.map((s) => [s.id, s.latest]) ?? []);
  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <main className="flex min-w-0 flex-1 p-1.5 max-md:p-0">
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface max-md:rounded-none max-md:border-0">
          <PaneHeader title="Organisation" count={view?.totals.repos}>
            {view && (
              <>
                <Button size="sm" variant="ghost" onClick={read}>
                  <RefreshCw /> Read again
                </Button>
                <Button size="sm" variant="ghost" onClick={signOut}>
                  <LogOut /> Sign out
                </Button>
              </>
            )}
          </PaneHeader>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            {load.state === "loading" ? (
              <PaneSkeleton />
            ) : load.state === "signed-out" ? (
              <SignIn onSignedIn={read} />
            ) : load.state === "failed" ? (
              <p role="alert" className="px-8 py-8 text-small text-danger">
                {load.message}
              </p>
            ) : load.view.repos.length === 0 ? (
              <NoRecords />
            ) : (
              <div className="mx-auto w-full max-w-5xl min-w-0 space-y-10 px-8 py-10 animate-enter max-md:px-4 max-md:py-6">
                <Headline view={load.view} />
                {load.view.systems.length > 0 && (
                  <div className="space-y-6">
                    <h2 className="text-heading">Adoption by version</h2>
                    {load.view.systems.map((system) => (
                      <Adoption key={system.id} system={system} />
                    ))}
                  </div>
                )}
                <div className="space-y-4">
                  <h2 className="text-heading">Repositories</h2>
                  {load.view.repos.map((repo) => (
                    <Repository key={repo.repo} repo={repo} latest={latest} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
