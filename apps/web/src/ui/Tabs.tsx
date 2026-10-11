/** Underline tabs on Radix Tabs (roving focus, arrow keys, ARIA), styled for dense detail panes. */
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { clsx } from "clsx";
import type { ComponentProps, ReactNode } from "react";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={clsx("flex h-10 shrink-0 items-stretch gap-5 overflow-x-auto border-b border-line px-6", className)} {...props} />;
}

interface TabsTriggerProps extends ComponentProps<typeof TabsPrimitive.Trigger> {
  count?: ReactNode;
}

export function TabsTrigger({ className, count, children, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={clsx(
        "relative inline-flex shrink-0 items-center gap-1.5 text-body font-medium whitespace-nowrap text-muted transition-colors duration-100 outline-none hover:text-ink focus-visible:text-ink data-[state=active]:text-ink",
        "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors data-[state=active]:after:bg-ink focus-visible:after:bg-focus",
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined && <span className="tabular text-caption text-faint">{count}</span>}
    </TabsPrimitive.Trigger>
  );
}
