import { clsx } from "clsx";
import { CopyButton } from "./CopyButton.tsx";

interface CodeBlockProps {
  code: string;
  /** A file name or caption shown in the header bar. */
  title?: string;
  className?: string;
  maxHeight?: "sm" | "lg" | "none";
}

const HEIGHTS = { sm: "max-h-56", lg: "max-h-[28rem]", none: "" } as const;

export function CodeBlock({ code, title, className, maxHeight = "lg" }: CodeBlockProps) {
  return (
    <div className={clsx("group overflow-hidden rounded-md border border-line bg-sunken", className)}>
      {title && (
        <div className="flex h-8 items-center justify-between border-b border-line pr-1 pl-3">
          <span className="truncate font-mono text-mono-sm text-muted">{title}</span>
          <CopyButton value={code} label={`Copy ${title}`} />
        </div>
      )}
      <div className="relative">
        <pre className={clsx("overflow-auto p-3 text-mono text-ink-2", HEIGHTS[maxHeight])}>
          <code>{code}</code>
        </pre>
        {!title && <CopyButton value={code} className="absolute top-1.5 right-1.5 bg-sunken opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />}
      </div>
    </div>
  );
}
