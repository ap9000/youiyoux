/** A listing's licence as a card and the preview say it: its SPDX id, or "licence unknown", plainly. */
import { Badge } from "../../ui/Badge.tsx";

export function LicenceBadge({ licence }: { licence: string }) {
  return licence === "unknown" ? (
    <Badge tone="warning" data-licence="unknown">
      licence unknown
    </Badge>
  ) : (
    <Badge tone="outline" data-licence={licence}>
      {licence}
    </Badge>
  );
}
