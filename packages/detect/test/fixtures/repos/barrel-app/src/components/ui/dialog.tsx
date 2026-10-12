import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "./button.js";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent({ children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 bg-black/50" />
      <DialogPrimitive.Content data-slot="dialog-content" className="fixed top-1/2 left-1/2 rounded-lg border p-6" {...props}>
        {children}
        <DialogPrimitive.Close asChild>
          <Button variant="ghost">Close</Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { Dialog, DialogContent };
