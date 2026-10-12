import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";

/** The widget: the CVA kit's Button and Badge beside the plain kit's, all styled by sheets no module imports. */
export function SyncWidget() {
  return (
    <div className="flex items-center gap-2">
      <Button>Sync</Button>
      <Badge>Beta</Badge>
      <button type="button" className="ui-button">
        Retry
      </button>
      <span className="ui-badge">3 failed</span>
    </div>
  );
}
