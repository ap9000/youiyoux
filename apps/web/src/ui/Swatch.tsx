/** A colour chip. Translucent values show over a checkerboard so their alpha is visible. */
import { clsx } from "clsx";

const SIZES = { xs: "size-3 rounded-[3px]", sm: "size-4 rounded-xs", md: "size-6 rounded-sm", lg: "size-8 rounded-md" } as const;

export function Swatch({ color, size = "sm", className }: { color: string; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span aria-hidden className={clsx("checker relative inline-block shrink-0 overflow-hidden", SIZES[size], className)}>
      <span className="edge absolute inset-0 rounded-[inherit]" style={{ background: color }} />
    </span>
  );
}
