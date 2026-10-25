/**
 * `/discover/specimen?id=<lib: id>[&project=<id>]`: one candidate drawn in the project's theme,
 * light and dark, each on a stage of its own, and nothing else. It is the page
 * `youiyoux discover previews` photographs for the gallery (scripts/capture-discover-thumbs.ts),
 * not one a person browses to. Opening it is opening the candidate, as from the drawer: only its
 * source is fetched, bundled by the hub's server and run in the sandboxed frame.
 *
 * A block is drawn as the top of its page (laid out at 1280 × 768, shown at a quarter).
 *
 * `data-capture-state` says when to photograph: `drawing`, then `ready` once its drawing has settled
 * (stopped changing; each stage's frame is `data-placed` once fitted) or `failed` with the reason
 * in `data-capture-reason`.
 */
import { useState } from "react";
import type { Scheme } from "../../app/theme.tsx";
import { useSearch } from "wouter";
import { useDrawn, useSettled } from "../../data/discover-preview.ts";
import { frameDocument, PAGE_HEIGHT, PAGE_WIDTH, ScrollRoot, SpecimenTile } from "../inventory/Specimens.tsx";
import { candidateTile, DrawProbe, usePreview } from "./candidate.tsx";
import { SCHEME_BACKDROP } from "./CandidatePanel.tsx";

/** A stage's width; its height is the stage tile's. Photographed at twice the pixels, it is about a gallery card's width. */
export const STAGE_WIDTH = 240;

/** A block's page, photographed whole at a quarter of its size: the top of the page, as a card shows it. */
const PAGE_SCALE = 0.25;
/** What the capture script cuts inside a stage's edge (capture-discover-thumbs.ts, INSET). */
const PAGE_INSET = 8;

function PageStage({ html, css, scheme }: { html: string; css: string; scheme: Scheme }) {
  const [placed, setPlaced] = useState(false);
  return (
    // The capture cuts PAGE_INSET inside a stage's edge, so the page's own edge sits that far in.
    <div data-capture-stage={scheme} className="rounded-md" style={{ padding: PAGE_INSET, background: SCHEME_BACKDROP[scheme] }}>
      <div className="overflow-hidden" style={{ width: PAGE_WIDTH * PAGE_SCALE, height: PAGE_HEIGHT * PAGE_SCALE }}>
      <iframe
        title="Page"
        aria-hidden
        tabIndex={-1}
        sandbox="allow-same-origin"
        srcDoc={frameDocument(html, css, scheme, true)}
        onLoad={(event) => {
          const fonts = event.currentTarget.contentDocument?.fonts;
          if (fonts) void fonts.ready.then(() => setPlaced(true), () => setPlaced(true));
          else setPlaced(true);
        }}
        data-placed={placed || undefined}
        className="pointer-events-none origin-top-left border-0"
        style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${PAGE_SCALE})`, colorScheme: scheme }}
      />
      </div>
    </div>
  );
}

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
  const settled = useSettled(id ?? "");
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
      <div className="flex flex-wrap content-start items-start gap-6 p-6" data-capture={id} data-capture-state={html && settled ? "ready" : "drawing"} data-capture-project={answer.project} data-capture-sha={answer.entry.provenance?.sha256 ?? ""}>
        <DrawProbe answer={answer} onFail={setFailure} />
        {/* Photographed once settled: an earlier drawing may still be animating in. */}
        {html && settled && answer.page && answer.css && (["light", "dark"] as const).map((scheme) => <PageStage key={scheme} html={html} css={answer.css![scheme]} scheme={scheme} />)}
        {html &&
          settled &&
          !answer.page &&
          (["light", "dark"] as const).map((scheme) => (
            <div key={scheme} data-capture-stage={scheme} className="rounded-md" style={{ width: STAGE_WIDTH, background: SCHEME_BACKDROP[scheme] }}>
              <SpecimenTile tile={candidateTile(answer, html, scheme)} scheme={scheme} size="stage" as="div" caption={false} backdrop={SCHEME_BACKDROP[scheme]} onBlank={() => setFailure("It draws nothing visible on its own (it may need content, a provider or a parent)")} />
            </div>
          ))}
      </div>
    </ScrollRoot.Provider>
  );
}
