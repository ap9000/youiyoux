/**
 * A request's before and after: the screen as it was when the request was filed, beside the
 * screen's picture now, each cropped to the component (outlined) with room around it. After an
 * agent's change the route is captured again (`youiyoux screens capture --route`), and the
 * component is found on the new picture by its file and line; when the picture is no newer than
 * the request, or the line is gone, it says so instead of implying the work is shown.
 */
import { useEffect, useState } from "react";
import { asRequestError, serviceUrl, workflowApi, type RequestComparison, type RequestPictureView, type WorkflowRequestError } from "../../data/workflow.ts";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { when } from "../../lib/when.ts";
import { pct } from "../../lib/format.ts";

/** Room around the component, and the smallest crop, in page pixels. */
const MARGIN = 56;
const MIN = { width: 320, height: 180 };

type Box = NonNullable<RequestPictureView["box"]>;
type Page = NonNullable<RequestPictureView["page"]>;

/** The part of the page to show: the box with room around it, kept inside the page. */
export function cropOf(box: Box, page: Page): Box {
  const width = Math.min(page.width, Math.max(MIN.width, box.width + 2 * MARGIN));
  const height = Math.min(page.height, Math.max(MIN.height, box.height + 2 * MARGIN));
  const x = Math.min(Math.max(0, box.x + box.width / 2 - width / 2), page.width - width);
  const y = Math.min(Math.max(0, box.y + box.height / 2 - height / 2), page.height - height);
  return { x, y, width, height };
}

function Crop({ picture, label }: { picture: RequestPictureView; label: string }) {
  const src = serviceUrl(picture.url);
  if (!picture.box || !picture.page) return <img src={src} alt={label} className="w-full rounded-md border border-line" />;
  const crop = cropOf(picture.box, picture.page);
  return (
    <div className="relative overflow-hidden rounded-md border border-line bg-sunken" style={{ aspectRatio: `${crop.width} / ${crop.height}` }} data-crop>
      <img src={src} alt={label} className="absolute max-w-none" style={{ width: pct(picture.page.width, crop.width), left: pct(-crop.x, crop.width), top: pct(-crop.y, crop.height) }} />
      <span aria-hidden className="absolute rounded-[3px] outline-2 -outline-offset-1 outline-accent outline-solid" style={{ left: pct(picture.box.x - crop.x, crop.width), top: pct(picture.box.y - crop.y, crop.height), width: pct(picture.box.width, crop.width), height: pct(picture.box.height, crop.height) }} />
    </div>
  );
}

export function BeforeAfter({ id, route, worked }: { id: string; route: string; worked: boolean }) {
  const [state, setState] = useState<{ value: RequestComparison } | { error: WorkflowRequestError } | null>(null);
  useEffect(() => {
    let cancelled = false;
    workflowApi.compareRequest(id).then(
      (value) => !cancelled && setState({ value }),
      (error: unknown) => !cancelled && setState({ error: asRequestError(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (!state || "error" in state || (!state.value.before && !state.value.after)) return null;
  const { before, after } = state.value;
  const recapture = `youiyoux screens capture --base <the app in development> --route ${route}`;
  return (
    <figure className="space-y-1.5" data-before-after>
      <div className="grid grid-cols-2 gap-2">
        {[
          { picture: before, label: "Before", at: before ? `filed ${when(before.at)}` : "" },
          { picture: after, label: "Now", at: after ? `captured ${when(after.at)}` : "" },
        ].map(({ picture, label, at }) => (
          <div key={label} className="min-w-0 space-y-1" data-side={label.toLowerCase()}>
            <p className="flex items-baseline gap-1.5 text-caption">
              <span className="font-medium text-ink-2">{label}</span>
              <span className="truncate text-faint">{at}</span>
            </p>
            {picture ? <Crop picture={picture} label={`${label}: the component on ${route}`} /> : <p className="grid aspect-[16/9] place-items-center rounded-md border border-dashed border-line-strong p-2 text-center text-caption text-faint">No picture</p>}
          </div>
        ))}
      </div>
      {after && worked && !after.sinceFiled && (
        <figcaption className="space-y-1 text-caption text-warning" data-stale>
          <span>Not captured since this was filed, so the work is not in it: capture the screen again.</span>
          <span className="flex min-w-0 items-center gap-1 rounded-sm bg-sunken px-1.5 py-0.5 text-ink-2">
            <code className="min-w-0 flex-1 truncate font-mono text-mono-sm">{recapture}</code>
            <CopyButton value={recapture} label="Copy the capture command" />
          </span>
        </figcaption>
      )}
      {after && !after.found && after.sinceFiled && <figcaption className="text-caption text-muted">Its line is not on the new picture, so it is outlined where it was.</figcaption>}
    </figure>
  );
}
