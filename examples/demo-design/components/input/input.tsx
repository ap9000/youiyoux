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
        "h-9 w-full rounded-control border border-line bg-background px-3 text-body text-foreground outline-none transition-colors duration-(--demo-motion-duration-fast) ease-out placeholder:text-muted focus-visible:border-(--demo-input-focus-border) focus-visible:[outline:var(--demo-input-focus-ring)] focus-visible:[outline-offset:var(--demo-input-focus-ring-offset)] disabled:cursor-not-allowed disabled:opacity-(--demo-input-disabled-opacity) aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}
