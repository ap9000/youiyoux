import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";

export function InviteForm() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite people</CardTitle>
      </CardHeader>
      <CardContent>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" placeholder="ada@example.com" />
        <div className="flex justify-end gap-2">
          <button className="text-muted underline">Copy invite link</button>
          <Button>Send invite</Button>
        </div>
      </CardContent>
    </Card>
  );
}
