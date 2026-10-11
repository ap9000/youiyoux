import { Input } from "@/components/ui";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-line px-6 py-3">
        <span className="text-label">Demo</span>
        <Input type="search" placeholder="Search projects" className="max-w-xs" />
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
