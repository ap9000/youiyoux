/**
 * `/discover/specimen?id=<lib: id>[&project=<id>]`: one candidate drawn in the project's theme,
 * light and dark, each on a stage of its own, and nothing else. It is the page
 * `youiyoux discover previews` photographs for the gallery (scripts/capture-discover-thumbs.ts),
 * not one a person browses to. Opening it is opening the candidate, as from the drawer: only its
 * source is fetched, bundled by the hub's server and run in the sandboxed frame.
 *
 * `data-capture-state` says when to photograph: `drawing`, then `ready` once it has drawn (each
 * stage's frame is `data-placed` once fitted) or `failed` with the reason in `data-capture-reason`.
 */
import { useState } from "react";
import { useSearch } from "wouter";
import { useDrawn } from "../../data/discover-preview.ts";
import { ScrollRoot, SpecimenTile } from "../inventory/Specimens.tsx";
import { candidateTile, DrawProbe, usePreview } from "./candidate.tsx";
import { SCHEME_BACKDROP } from "./CandidatePanel.tsx";

/** A stage's width; its height is the stage tile's. Photographed at twice the pixels, it is about a gallery card's width. */
export const STAGE_WIDTH = 240;

function Failed({ id, reason }: { id: string; reason: string }) {
  return (
    <p className="p-6 text-small text-muted" data-capture={id} data-capture-state="failed" data-capture-reason={reason}>
      {reason}
    </p>
  );
}

export function SpecimenCapture() {
  const params = new URLSearchParams(useSearch());
  const id = params.get("id");
  const project = params.get("project");
  const state = usePreview(id, project);
  const html = useDrawn(id ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  if (!id) return <Failed id="" reason="No candidate named: add ?id=<lib: id>." />;
  if (state === null)
    return (
      <p className="p-6 text-small text-faint" data-capture={id} data-capture-state="drawing">
        Fetching {id}…
      </p>
    );
  if (state.status === "error") return <Failed id={id} reason={state.message} />;
  const { answer } = state;
  const error = answer.error ?? failure;
  if (error) return <Failed id={id} reason={error} />;
  return (
    <ScrollRoot.Provider value={null}>
      <div className="flex flex-wrap content-start items-start gap-6 p-6" data-capture={id} data-capture-state={html ? "ready" : "drawing"} data-capture-project={answer.project} data-capture-sha={answer.entry.provenance?.sha256 ?? ""}>
        <DrawProbe answer={answer} onFail={setFailure} />
        {html &&
          (["light", "dark"] as const).map((scheme) => (
            <div key={scheme} data-capture-stage={scheme} className="rounded-md" style={{ width: STAGE_WIDTH, background: SCHEME_BACKDROP[scheme] }}>
              <SpecimenTile tile={candidateTile(answer, html, scheme)} scheme={scheme} size="stage" as="div" caption={false} backdrop={SCHEME_BACKDROP[scheme]} onBlank={() => setFailure("It draws nothing visible on its own (it may need content, a provider or a parent)")} />
            </div>
          ))}
      </div>
    </ScrollRoot.Provider>
  );
}
