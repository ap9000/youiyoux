import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

export const badgeVariants = cva("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium", {
  variants: { tone: { warning: "bg-warning text-warning-foreground", brand: "bg-brand text-brand-foreground" } },
  defaultVariants: { tone: "warning" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={badgeVariants({ tone, className })} {...props} />;
}
