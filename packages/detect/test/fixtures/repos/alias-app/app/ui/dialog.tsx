import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent(props: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Content data-slot="dialog-content" className="fixed rounded-lg border p-6" {...props} />;
}

export { Dialog, DialogContent };
