import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main>
      <h1>Releases</h1>
      <Badge>Draft</Badge>
      <Button>Publish</Button>
      <Button variant="outline">Preview</Button>
      <Button variant="outline">Discard</Button>
    </main>
  );
}
