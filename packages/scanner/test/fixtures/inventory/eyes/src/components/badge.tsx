import type { ComponentProps } from "react";

export function Badge({ className = "", ...props }: ComponentProps<"span">) {
  return <span className={`inline-flex h-5 items-center rounded-full bg-emerald-700 px-2 text-xs font-medium text-white ${className}`} {...props} />;
}
