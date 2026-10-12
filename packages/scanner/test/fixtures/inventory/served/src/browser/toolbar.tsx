import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

/** The toolbar: the CVA kit's Button and Badge beside the plain kit's, all coloured by tokens only the server inlines. */
export function Toolbar() {
  return (
    <div className="flex items-center gap-2">
      <Button>Run</Button>
      <Badge>Live</Badge>
      <button type="button" className="ui-button">
        Retry
      </button>
    </div>
  );
}
