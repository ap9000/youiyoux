/** Demo Input: a single-line field. */
import type { ComponentProps } from "react";
import { cn } from "./utils";

export function Input({ className, invalid = false, type, ...props }: ComponentProps<"input"> & { invalid?: boolean }) {
  return (
    <input
      data-slot="input"
      type={type ?? "text"}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-9 w-full rounded-control border border-line bg-background px-3 text-body text-foreground outline-none transition-colors duration-150 ease-out placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}
