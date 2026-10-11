import { cn } from "./utils";
export function buttonVariants(o: { variant?: string; size?: string } = {}): string { return cn("btn", o.variant, o.size); }
export function Button({ variant, size, className, ...props }: { variant?: string; size?: string; className?: string; children?: unknown; onClick?: () => void }) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
