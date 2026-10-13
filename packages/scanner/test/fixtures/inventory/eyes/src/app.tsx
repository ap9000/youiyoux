import { Badge } from "./components/badge";
import { Button } from "./components/button";
import { SearchInput } from "./components/search-input";

/** The one screen: a search field, two buttons and a badge. */
export function App() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <SearchInput />
      <div className="flex items-center gap-2">
        <Button>Save</Button>
        <Button variant="outline">Cancel</Button>
        <Badge>New</Badge>
      </div>
    </main>
  );
}
