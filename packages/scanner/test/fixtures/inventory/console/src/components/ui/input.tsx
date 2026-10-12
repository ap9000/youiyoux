import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn("h-8 w-full rounded-md border px-3 text-sm", className)} {...props} />;
}
