// @generated from components/button/button.tsx by apps/web/scripts/snapshot.ts. Do not edit.
/** Demo Button: every action a person can take. */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control text-label transition-colors duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-on-accent hover:bg-accent/90",
        outline: "border border-line bg-background text-foreground hover:bg-card",
        ghost: "text-muted hover:bg-card hover:text-foreground",
        danger: "bg-danger-soft text-danger hover:bg-danger/15",
        link: "text-accent underline underline-offset-4",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 px-2.5",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ className, variant, size, type, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button data-slot="button" type={type ?? "button"} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
