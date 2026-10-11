/** Small status and fact labels. Colour is for status only; facts are neutral. */
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import type { ComponentProps } from "react";
import type { ComponentStatus, RuleSeverity } from "../data/types.ts";

export const badgeVariants = cva(
  "inline-flex h-[18px] w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-caption [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-neutral-soft text-ink-2",
        accent: "bg-accent-soft text-accent",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        outline: "border border-line text-muted",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={clsx(badgeVariants({ tone }), className)} {...props} />;
}

const STATUS_TONE: Record<ComponentStatus, BadgeTone> = { stable: "success", beta: "warning", draft: "neutral", deprecated: "danger" };
const SEVERITY_TONE: Record<RuleSeverity, BadgeTone> = { error: "danger", warn: "warning", off: "neutral" };

export function StatusBadge({ status }: { status: ComponentStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}

export function SeverityBadge({ severity }: { severity: RuleSeverity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{severity === "warn" ? "Warning" : severity === "error" ? "Error" : "Off"}</Badge>;
}
