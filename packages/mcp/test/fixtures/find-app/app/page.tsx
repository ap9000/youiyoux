import { PlusIcon } from "lucide-react";
import { Alert } from "@/components/alert";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main>
      <Alert tone="warning" title="Your trial ends soon" onDismiss={() => {}}>
        Add a card to keep your projects.
      </Alert>
      <Button variant="primary">
        <PlusIcon /> New project
      </Button>
      <Button variant="outline">Import</Button>
    </main>
  );
}
