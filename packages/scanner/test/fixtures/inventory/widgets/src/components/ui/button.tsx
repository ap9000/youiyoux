import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

export const buttonVariants = cva("inline-flex items-center justify-center rounded-md text-sm font-medium", {
  variants: {
    variant: {
      default: "bg-brand text-brand-foreground hover:bg-brand/90",
      outline: "border border-brand text-brand",
    },
    size: { default: "h-8 px-3", sm: "h-7 px-2.5 text-xs" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export function Button({ className, variant, size, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={buttonVariants({ variant, size, className })} {...props} />;
}
