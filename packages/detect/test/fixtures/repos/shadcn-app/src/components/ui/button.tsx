import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva("inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium", {
  variants: { variant: { default: "bg-primary text-primary-foreground", outline: "border bg-background" } },
  defaultVariants: { variant: "default" },
});

function Button({ className, variant, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={buttonVariants({ variant, className })} {...props} />;
}

export { Button, buttonVariants };
