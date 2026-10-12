import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva("inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium", {
  variants: { variant: { default: "bg-primary text-primary-foreground", ghost: "hover:bg-accent" } },
  defaultVariants: { variant: "default" },
});

function Button({ className, variant, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button data-slot="button" className={cn(buttonVariants({ variant }), className)} {...props} />;
}

export { Button, buttonVariants };
