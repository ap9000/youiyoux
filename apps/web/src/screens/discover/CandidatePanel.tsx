/**
 * An opened candidate in the drawer (a tall bottom sheet on a phone). First, once the hub's server
 * has fetched and bundled it, the thing itself running in the project's theme (Stage, or a block's
 * PagePreview), light or dark, with its states drawn still beneath; then its listing; what drew
 * with the project's tokens and what could not, in plain words; what it is built from and what it
 * imports without declaring; and the actions.
 */
import { CircleAlert, CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { descriptionOf, signalLines, sourceOf, type DiscoverHit } from "../../data/discover.ts";
import { useDrawn, type PreviewAnswer, type PreviewState } from "../../data/discover-preview.ts";
import { LARGE_TILE_HEIGHT, SpecimenTile, StateStrip } from "../inventory/Specimens.tsx";
import { CandidateActions } from "./Actions.tsx";
import { candidateTile } from "./candidate.tsx";
import { LicenceBadge } from "./LicenceBadge.tsx";
import { PagePreview } from "./PagePreview.tsx";
import { Stage } from "./Stage.tsx";

/** Behind a scheme's tile whatever scheme the hub is in, for a page that paints no background of its own. */
export const SCHEME_BACKDROP: Readonly<Record<Scheme, string>> = { light: "#fcfcfd", dark: "#0f1011" };

/** A registry's own site, to look at a block that could not be drawn here: https only. */
export function siteOf(url: string | null | undefined): { href: string; host: string } | null {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "https:" ? { href: parsed.href, host: parsed.host } : null;
  } catch {
    return null;
  }
}

/** The stage's height while there is nothing to run yet, so the drawer does not jump when it starts. */
const WAITING = "grid h-[min(420px,48dvh)] place-items-center rounded-md border border-line bg-sunken px-4 text-center text-small text-faint";

function Drawing({ answer, failure, scheme, onEscape }: { answer: PreviewAnswer; failure: string | null; scheme: Scheme; onEscape: () => void }) {
  const html = useDrawn(answer.id);
  const error = answer.error ?? failure;
  if (error) {
    const site = answer.entry.kind === "pattern" ? siteOf(answer.entry.source.url) : null;
    return (
      <p className="rounded-md border border-dashed border-line-strong p-3 text-small text-muted" data-preview-error>
        {`No drawing: ${error.replace(/\.$/, "")}.`}
        {site && (
          <>
            {" "}
            <a href={site.href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2" data-site-link>
              Find {answer.name} on {site.host}
            </a>
            , drawn as its authors made it.
          </>
        )}
      </p>
    );
  }
  // A block is a page: one large frame with its width and scheme to choose, running from the start.
  if (answer.page && answer.css && (answer.script || html))
    return (
      <div data-drawn={html ? answer.id : undefined}>
        <PagePreview answer={answer} html={html} scheme={scheme} onEscape={onEscape} />
      </div>
    );
  // A component runs on the stage at once; its states are drawn still beneath, once the hidden frame has drawn it.
  const { script, css } = answer;
  if (script && css)
    return (
      <div className="space-y-4">
        <Stage answer={{ ...answer, script, css }} scheme={scheme} onEscape={onEscape} />
        {html && (
          <div className="space-y-1.5" data-drawn={answer.id}>
            <h4 className="text-small font-medium text-ink-2">Its states</h4>
            <StateStrip tile={candidateTile(answer, html, scheme, `${answer.id}:states`)} scheme={scheme} label={answer.name} />
          </div>
        )}
      </div>
    );
  if (!html)
    return (
      <p aria-busy="true" className="grid place-items-center rounded-md border border-line bg-sunken text-small text-faint" style={{ height: LARGE_TILE_HEIGHT }}>
        Drawing it in your theme…
      </p>
    );
  return (
    <div className="space-y-3" data-drawn={answer.id}>
      <ul className="grid grid-cols-2 gap-2 max-sm:grid-cols-1" aria-label="In your theme, light and dark">
        {(["light", "dark"] as const).map((s) => (
          <li key={s} className="min-w-0 space-y-1">
            <p className="text-caption text-muted">{s === "light" ? "Light" : "Dark"}</p>
            <SpecimenTile tile={candidateTile(answer, html, s)} scheme={s} size="large" as="div" caption={false} tryIt backdrop={SCHEME_BACKDROP[s]} />
          </li>
        ))}
      </ul>
      <StateStrip tile={candidateTile(answer, html, scheme, `${answer.id}:states`)} scheme={scheme} label={answer.name} />
    </div>
  );
}

function Lines({ title, icon, lines, tone, empty }: { title: string; icon: ReactNode; lines: readonly string[]; tone: "success" | "warning"; empty: string }) {
  return (
    <section className="min-w-0 space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-small font-medium text-ink-2">
        {icon}
        {title}
      </h4>
      {lines.length === 0 ? (
        <p className="text-small text-muted">{empty}</p>
      ) : (
        <ul className="space-y-1" data-fit={tone === "success" ? "themed" : "unthemed"}>
          {lines.map((line) => (
            <li key={line} className="text-small text-ink-2">
              {line}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CandidatePanel({ hit, state, scheme, family, failure, onClose }: { hit: DiscoverHit; state: PreviewState | null; scheme: Scheme; family: string | null; failure: string | null; onClose: () => void }) {
  const answer = state?.status === "ready" ? state.answer : null;
  const signals = signalLines(hit);
  return (
    <div className="space-y-6 px-5 py-4 max-sm:px-4" data-candidate={hit.id}>
      <section aria-labelledby="candidate-drawing" className="space-y-2">
        <h3 id="candidate-drawing" className="sr-only">
          Running in your theme
        </h3>
        {state === null ? (
          <p aria-busy="true" className={WAITING}>
            Fetching only this item's source, then running it with your project's CSS…
          </p>
        ) : state.status === "error" ? (
          <p className="rounded-md border border-dashed border-line-strong p-3 text-small text-muted" data-preview-error>
            {state.message}
          </p>
        ) : (
          <Drawing answer={state.answer} failure={failure} scheme={scheme} onEscape={onClose} />
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-mono-sm text-ink-2">{hit.source.ref ?? hit.name}</code>
          <LicenceBadge licence={hit.license} />
          {signals.map((s) => (
            <span key={s} className="tabular text-caption text-muted">
              {s}
            </span>
          ))}
        </div>
        {descriptionOf(hit) ? <p className="text-small text-ink-2">{descriptionOf(hit)}</p> : <p className="text-small text-muted">{sourceOf(hit)} gives no description for it.</p>}
        <p className="text-caption text-muted">An outside reference from {sourceOf(hit)}: not in your system and not approved.</p>
      </section>

      {answer && !answer.error && (
        <div className="grid gap-4 md:grid-cols-2">
          <Lines title="Themed with your tokens" icon={<CircleCheck aria-hidden className="size-3.5 text-success" />} lines={answer.fit.themed} tone="success" empty="Nothing it uses maps to a token of yours." />
          <Lines title="Could not be themed" icon={<CircleAlert aria-hidden className="size-3.5 text-warning" />} lines={answer.fit.unthemed} tone="warning" empty="Everything measured draws with your tokens." />
        </div>
      )}

      {answer && (answer.parts.length > 0 || answer.notes.length > 0 || answer.implicitDeps.length > 0) && (
        <section aria-labelledby="candidate-built" className="space-y-1.5">
          <h3 id="candidate-built" className="text-heading">
            What it is built from
          </h3>
          <ul className="space-y-1 text-small text-ink-2">
            {answer.parts.map((part) => (
              <li key={part.name}>{part.detail}</li>
            ))}
            {answer.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
            {answer.implicitDeps.length > 0 && <li data-implicit>Imports without declaring: {answer.implicitDeps.join(", ")} (an install would need {answer.implicitDeps.length === 1 ? "it" : "them"} too)</li>}
          </ul>
        </section>
      )}

      <CandidateActions entry={answer?.entry ?? null} licence={hit.license} install={hit.install?.command ?? answer?.install?.command ?? null} family={family} />
    </div>
  );
}
