import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

const projects = [
  { name: "Atlas", detail: "3 members · updated today" },
  { name: "Juniper", detail: "1 member · updated last week" },
];

export default function Home() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-label">Projects</h1>
        <Button>New project</Button>
      </div>
      {projects.map((project) => (
        <Card key={project.name}>
          <CardHeader>
            <CardTitle>{project.name}</CardTitle>
            <Button variant="outline" size="sm">Open</Button>
          </CardHeader>
          <CardContent>{project.detail}</CardContent>
        </Card>
      ))}
      <div className="rounded-[12px] border border-line p-4 text-muted">Archived projects appear here.</div>
    </div>
  );
}
