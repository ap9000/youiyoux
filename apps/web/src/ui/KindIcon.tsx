/** The leading mark of an element row: a swatch for colours, an icon for everything else. */
import { clsx } from "clsx";
import { Box, CaseSensitive, Layers, type LucideIcon, Ruler, ShieldCheck, Spline, Square, Type } from "lucide-react";
import type { Scheme } from "../app/theme.tsx";
import type { ElementSummary } from "../data/model.ts";
import { Swatch } from "./Swatch.tsx";

const TOKEN_ICONS: Record<string, LucideIcon> = { typography: Type, shadow: Layers, fontFamily: CaseSensitive, cubicBezier: Spline };

function iconFor(element: ElementSummary): LucideIcon {
  if (element.kind === "component") return Box;
  if (element.kind === "rule") return ShieldCheck;
  if (element.group === "radius") return Square;
  return TOKEN_ICONS[element.tokenType ?? ""] ?? Ruler;
}

export function KindIcon({ element, scheme, className }: { element: ElementSummary; scheme: Scheme; className?: string }) {
  if (element.swatch) return <Swatch color={element.swatch[scheme]} size="xs" className={clsx("m-0.5", className)} />;
  const Icon = iconFor(element);
  const tone = element.kind === "rule" ? (element.severity === "error" ? "text-danger" : element.severity === "warn" ? "text-warning" : "text-muted") : "text-muted";
  return <Icon aria-hidden className={clsx("size-4 shrink-0", tone, className)} />;
}
