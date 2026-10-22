/**
 * A native details/summary that unfolds: the chevron turns while the content's height opens and
 * the content slides up into place (app.css animates `::details-content` where the browser can).
 * Native, so it is keyboard- and reader-friendly for free; put `justify-between` on the summary to
 * send the chevron to the far edge.
 */
import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  className?: string;
  summaryClassName?: string;
}

export function Disclosure({ summary, children, open, className, summaryClassName }: DisclosureProps) {
  return (
    <details open={open} className={clsx("group/disclosure", className)}>
      <summary className={clsx("flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden", summaryClassName)}>
        {summary}
        <ChevronDown
          aria-hidden
          data-chevron
          className="size-3.5 shrink-0 text-faint transition-transform duration-(--yx-duration-base) ease-(--yx-easing-out) group-open/disclosure:rotate-180"
        />
      </summary>
      {children}
    </details>
  );
}
