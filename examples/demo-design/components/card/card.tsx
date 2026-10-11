/** Demo Card: a container for one subject, and its parts. */
import type { ComponentProps } from "react";
import { cn } from "./utils";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="card" className={cn("flex flex-col gap-3 rounded-card border border-line bg-card p-5 text-foreground shadow-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex items-start justify-between gap-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("text-label text-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("flex flex-col gap-3 text-body text-muted", className)} {...props} />;
}
