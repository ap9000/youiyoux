import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("inline-flex items-center gap-2 rounded-md text-sm font-medium h-9 px-4", {
  variants: {
    variant: {
      default: "bg-neutral-900 text-white",
      primary: "bg-blue-600 text-white",
      outline: "border border-neutral-300",
    },
    size: {
      default: "h-9 px-4",
      sm: "h-8 px-3",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
