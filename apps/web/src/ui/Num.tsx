/** A number inside a headline sentence (rule data.headline): ink with a hairline underline, a link when it leads somewhere. */
import type { ReactNode } from "react";
import { Link } from "wouter";

export function Num({ value, href, clean }: { value: ReactNode; href?: string; clean?: boolean }) {
  const look = `tabular font-semibold underline decoration-line-strong decoration-2 underline-offset-[0.2em] ${clean ? "text-success" : "text-ink"}`;
  return href ? (
    <Link href={href} className={`${look} hover:decoration-accent`}>
      {value}
    </Link>
  ) : (
    <span className={look}>{value}</span>
  );
}
