import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, children, actions, className }: EmptyStateProps) {
  return (
    <div className={clsx("flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center animate-fade", className)}>
      <span className="grid size-9 place-items-center rounded-lg border border-line bg-raised text-muted">
        <Icon className="size-4" />
      </span>
      <div className="space-y-1">
        <h2 className="text-heading">{title}</h2>
        {children && <div className="mx-auto max-w-sm text-small text-muted">{children}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
