/**
 * A listing's licence as a card and the preview say it: its SPDX id, or "licence unknown", plainly.
 * A strong copyleft licence is marked, since shipping it means releasing your code under it too.
 */
import { copyleft } from "@youiyoux/core/licence";
import { Badge } from "../../ui/Badge.tsx";

export function LicenceBadge({ licence }: { licence: string }) {
  if (licence === "unknown") {
    return (
      <Badge tone="warning" data-licence="unknown">
        licence unknown
      </Badge>
    );
  }
  return copyleft(licence) ? (
    <Badge tone="warning" data-licence={licence} data-copyleft title="Copyleft: code you ship with it must be released under the same licence">
      {licence} · copyleft
    </Badge>
  ) : (
    <Badge tone="outline" data-licence={licence}>
      {licence}
    </Badge>
  );
}
