import { clsx } from "clsx";
import type { ComponentProps } from "react";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={clsx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line border-b-line-strong bg-surface px-1 font-sans text-caption text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function Keys({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-0.5", className)}>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}
