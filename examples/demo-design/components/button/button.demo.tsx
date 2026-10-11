/** Hub preview for Button: every variant, size and state a reviewer needs to judge it. */
import { ArrowRight, Settings, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-16 shrink-0 text-label text-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export default function ButtonDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Row label="variant">
        <Button>Publish</Button>
        <Button variant="outline">
          Open <ArrowRight />
        </Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">
          <Trash2 /> Delete project
        </Button>
        <Button variant="link">View history</Button>
      </Row>
      <Row label="size">
        <Button variant="outline" size="sm">
          Small
        </Button>
        <Button variant="outline">Default</Button>
        <Button variant="outline" size="icon" aria-label="Settings">
          <Settings />
        </Button>
      </Row>
      <Row label="state">
        <Button disabled>Disabled</Button>
        <Button variant="outline" disabled>
          Disabled
        </Button>
      </Row>
    </div>
  );
}
