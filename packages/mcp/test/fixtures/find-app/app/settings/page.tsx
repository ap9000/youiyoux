"use client";
import { useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Modal } from "@/components/modal";
import Snackbar from "@/components/snackbar";
import { Button } from "@/components/ui/button";

export default function Settings() {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <Button onClick={() => setOpen(true)}>Delete workspace</Button>
          </Tooltip.Trigger>
          <Tooltip.Content>This cannot be undone</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
      <Modal open={open} onOpenChange={setOpen} title="Delete workspace?">
        <p>Everything in it is removed.</p>
      </Modal>
      <Snackbar message="Settings saved" />
    </section>
  );
}
