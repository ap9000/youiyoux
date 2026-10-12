import { BrowserToolbar } from "@/browser/toolbar";
import { Button } from "@/components/ui/button";

export default function BrowserPage() {
  return (
    <main className="p-8">
      <BrowserToolbar />
      <Button>Open</Button>
    </main>
  );
}
