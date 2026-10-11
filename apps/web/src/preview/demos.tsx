/**
 * One demo per component: the states a reviewer needs to judge it, written with the
 * same owned files a project vendors (src/preview/generated/signal, from `pnpm data`).
 */
import { ArrowRight, Check, CircleAlert, Loader, Plus, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "./generated/signal/badge.tsx";
import { Button } from "./generated/signal/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./generated/signal/card.tsx";
import { Input, Label, Separator, Textarea } from "./generated/signal/form-controls.tsx";
import { Switch } from "./generated/signal/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./generated/signal/tabs.tsx";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function ButtonDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Row label="variant">
        <Button>Save</Button>
        <Button variant="attention">Approve</Button>
        <Button variant="outline">
          Open <ArrowRight />
        </Button>
        <Button variant="secondary">Duplicate</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="destructive">Delete run</Button>
        <Button variant="link">View log</Button>
      </Row>
      <Row label="size">
        <Button size="sm" variant="outline">
          Small
        </Button>
        <Button variant="outline">Default</Button>
        <Button size="lg" variant="outline">
          Large
        </Button>
        <Button size="icon" variant="outline" aria-label="Settings">
          <Settings />
        </Button>
      </Row>
      <Row label="state">
        <Button disabled>Disabled</Button>
        <Button variant="outline" disabled>
          <Loader /> Waiting
        </Button>
      </Row>
    </div>
  );
}

function BadgeDemo() {
  return (
    <Row label="tone">
      <Badge>Queued</Badge>
      <Badge tone="success">
        <Check /> Checks passed
      </Badge>
      <Badge tone="warning">Setup needed</Badge>
      <Badge tone="attention">Needs you</Badge>
      <Badge tone="danger">
        <CircleAlert /> Failed
      </Badge>
      <Badge tone="info">Running</Badge>
    </Row>
  );
}

function CardDemo() {
  return (
    <div className="max-w-md">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-1">
            <CardTitle>Release 0.9.59</CardTitle>
            <CardDescription>Safer deploys and planner resets, waiting on your review.</CardDescription>
          </div>
          <Badge tone="attention">Needs you</Badge>
        </CardHeader>
        <CardContent>
          <Separator />
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-muted-foreground">Checks</span>
            <Badge tone="success">
              <Check /> 14 passed
            </Badge>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline">Open</Button>
            <Button variant="attention">Approve</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FieldDemo({ textarea = false }: { textarea?: boolean }) {
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="demo-name">Project name</Label>
        {textarea ? <Textarea id="demo-name" placeholder="What should the agent do next?" defaultValue="" /> : <Input id="demo-name" placeholder="toolroll" />}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="demo-filled">{textarea ? "Notes" : "Repository"}</Label>
        {textarea ? <Textarea id="demo-filled" defaultValue={"Ship the planner reset behind a flag.\nRoll back if checks fail twice."} /> : <Input id="demo-filled" defaultValue="github.com/acme/toolroll" />}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="demo-disabled">Disabled</Label>
        {textarea ? <Textarea id="demo-disabled" disabled placeholder="Locked while a run is active" /> : <Input id="demo-disabled" disabled placeholder="Locked while a run is active" />}
      </div>
    </div>
  );
}

function LabelDemo() {
  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="demo-label-input">Branch</Label>
      <Label>
        <Switch defaultChecked /> Auto-approve passing checks
      </Label>
    </div>
  );
}

function SwitchDemo() {
  return (
    <div className="flex flex-col gap-3">
      <Label>
        <Switch defaultChecked /> Run checks on every push
      </Label>
      <Label>
        <Switch /> Notify me in Slack
      </Label>
      <Label className="opacity-50">
        <Switch disabled /> Managed by your admin
      </Label>
    </div>
  );
}

function TabsDemo() {
  return (
    <Tabs defaultValue="overview" className="flex flex-col gap-3">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="activity">
          Activity <span className="text-muted-foreground">12</span>
        </TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="text-[13px] text-muted-foreground">
        Three tasks are running and one waits on you.
      </TabsContent>
      <TabsContent value="activity" className="text-[13px] text-muted-foreground">
        12 events in the last hour.
      </TabsContent>
      <TabsContent value="settings" className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Button size="sm" variant="outline">
          <Plus /> Add rule
        </Button>
      </TabsContent>
    </Tabs>
  );
}

export const DEMOS: Readonly<Record<string, () => ReactNode>> = {
  button: ButtonDemo,
  badge: BadgeDemo,
  card: CardDemo,
  input: () => <FieldDemo />,
  textarea: () => <FieldDemo textarea />,
  label: LabelDemo,
  switch: SwitchDemo,
  tabs: TabsDemo,
};
