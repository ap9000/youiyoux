/** `?`: every keyboard shortcut on one sheet. */
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Keys } from "../ui/Kbd.tsx";
import { SHORTCUTS } from "./keyboard.ts";

export function CheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade" />
        <Dialog.Content className="fixed inset-x-0 top-[14vh] z-50 mx-auto w-[min(480px,calc(100vw-24px))] rounded-xl border border-line bg-surface shadow-popover outline-none animate-pop">
          <header className="flex h-12 items-center border-b border-line px-5">
            <Dialog.Title className="text-heading">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink">
              <X className="size-4" />
            </Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">Shortcuts work anywhere except while typing in a field.</Dialog.Description>
          <div className="grid gap-5 p-5">
            {SHORTCUTS.map((group) => (
              <section key={group.group} className="space-y-1.5">
                <h3 className="text-caption text-muted">{group.group}</h3>
                <ul className="divide-y divide-line">
                  {group.items.map((item) => (
                    <li key={item.label} className="flex h-8 items-center justify-between text-body">
                      <span className="text-ink-2">{item.label}</span>
                      <Keys keys={item.keys} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
