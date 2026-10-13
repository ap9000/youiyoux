import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

/** shadcn's dialog root: wraps Radix. */
function RadixDialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/** shadcn's alert, in the same module: plain markup, no Radix. */
function PlainAlert({ children }: { children: ReactNode }) {
  return <div data-slot="alert" role="alert">{children}</div>;
}

export { RadixDialog, PlainAlert };
