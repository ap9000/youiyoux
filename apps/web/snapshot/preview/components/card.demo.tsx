// @generated from card/card.demo.tsx by apps/web/scripts/snapshot.ts. Do not edit.
/** Hub preview for Card: a header with an action, and content. */
import { Button } from "./button";
import { Card, CardContent, CardHeader, CardTitle } from "./card";

export default function CardDemo() {
  return (
    <div className="flex max-w-md flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Atlas</CardTitle>
          <Button variant="outline" size="sm">
            Open
          </Button>
        </CardHeader>
        <CardContent>
          <p>3 members · updated today</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost">Archive</Button>
            <Button>Invite people</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
