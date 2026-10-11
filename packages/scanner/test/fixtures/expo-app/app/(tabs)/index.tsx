import { Button, Card, CardHeader } from "@/components/ui";
export default function Home() {
  return <Card>
    <CardHeader>Start</CardHeader>
    <Button variant="outline" size="sm">Open</Button>
    <Button variant="primary">Save</Button>
    <div className="bg-[#2563EB] rounded-[10px] p-3">PR #123 shipped</div>
    <p style={{ color: "#c4320a" }}>Failed</p>
    <button className="rounded bg-black text-white">Raw</button>
    <input type="hidden" name="csrf" />
    {/* youi-ignore color.no-raw-color: brand partner logo colour */}
    <i style={{ color: "#ff00ff" }} />
  </Card>;
}
