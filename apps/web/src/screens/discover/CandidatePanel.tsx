/**
 * An opened candidate in the drawer (a bottom sheet on a phone): its listing, then, once the
 * hub's server has fetched and bundled it, its drawing in the project's theme, light and dark,
 * with Try it and its five states; what drew with the project's tokens and what could not, in
 * plain words; what it is built from and what it imports without declaring; and the actions.
 */
import { CircleAlert, CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { signalLines, sourceOf, type DiscoverHit } from "../../data/discover.ts";
import { useDrawn, type PreviewAnswer, type PreviewState } from "../../data/discover-preview.ts";
import { LARGE_TILE_HEIGHT, SpecimenTile, StateStrip } from "../inventory/Specimens.tsx";
import { CandidateActions } from "./Actions.tsx";
import { candidateTile } from "./candidate.tsx";
import { LicenceBadge } from "./LicenceBadge.tsx";

/** Behind a scheme's tile whatever scheme the hub is in, for a page that paints no background of its own. */
const SCHEME_BACKDROP: Readonly<Record<Scheme, string>> = { light: "#fcfcfd", dark: "#0f1011" };

function Drawing({ answer, failure, scheme }: { answer: PreviewAnswer; failure: string | null; scheme: Scheme }) {
  const html = useDrawn(answer.id);
  const error = answer.error ?? failure;
  if (error) return <p className="rounded-md border border-dashed border-line-strong p-3 text-small text-muted" data-preview-error>{`No drawing: ${error.replace(/\.$/, "")}.`}</p>;
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

export function CandidatePanel({ hit, state, scheme, family, failure }: { hit: DiscoverHit; state: PreviewState | null; scheme: Scheme; family: string | null; failure: string | null }) {
  const answer = state?.status === "ready" ? state.answer : null;
  const signals = signalLines(hit);
  return (
    <div className="space-y-6 px-5 py-4" data-candidate={hit.id}>
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
        <p className="text-small text-ink-2">{hit.summary}</p>
        <p className="text-caption text-muted">An outside reference from {sourceOf(hit)}: not in your system and not approved.</p>
      </section>

      <section aria-labelledby="candidate-drawing" className="space-y-2">
        <h3 id="candidate-drawing" className="text-heading">
          In your theme
        </h3>
        {state === null ? (
          <p aria-busy="true" className="text-small text-faint">
            Fetching only this item's source, then drawing it with your project's CSS…
          </p>
        ) : state.status === "error" ? (
          <p className="rounded-md border border-dashed border-line-strong p-3 text-small text-muted" data-preview-error>
            {state.message}
          </p>
        ) : (
          <Drawing answer={state.answer} failure={failure} scheme={scheme} />
        )}
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
