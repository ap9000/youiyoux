import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function DashboardPage() {
  return (
    <main className="space-y-6 p-8">
      <Card>
        <CardTitle>Runs</CardTitle>
        <Badge tone="success">Live</Badge>
        <Button>
          <Plus className="size-4" /> New run
        </Button>
        <Button variant="outline">Export</Button>
        <Button asChild>
          <a href="/settings">Settings</a>
        </Button>
      </Card>
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
      </Tabs>
    </main>
  );
}
