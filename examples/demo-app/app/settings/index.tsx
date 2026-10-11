import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";

export default function Settings() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Project</CardTitle>
        </CardHeader>
        <CardContent>
          <label htmlFor="name">Name</label>
          <Input id="name" defaultValue="Atlas" />
          <label htmlFor="slug">Address</label>
          <Input id="slug" invalid defaultValue="atlas!" aria-describedby="slug-error" />
          <p id="slug-error" className="text-[#c62828]">Use letters, numbers and dashes.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost">Cancel</Button>
            <Button>Save</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <Button variant="danger">Delete project</Button>
        </CardHeader>
      </Card>
    </div>
  );
}
