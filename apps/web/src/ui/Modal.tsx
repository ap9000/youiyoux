/**
 * A dialog over the page, for the moments that need the person's whole attention: a secret typed
 * or shown once, a change to who can read something, a removal. Its title and one line on what it
 * is for at the top, its fields, its buttons at the foot. Esc, the close button or the scrim closes
 * it; with `onSubmit` it is a form, so Enter submits.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { X, type LucideIcon } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

interface ModalProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** The buttons, right-aligned at the foot (on a phone, each as wide as it can be). */
  footer: ReactNode;
  children?: ReactNode;
}

export function Modal({ title, description, icon: Icon, onClose, onSubmit, footer, children }: ModalProps) {
  const body = (
    <>
      {children && <div className="min-h-0 space-y-4 overflow-y-auto px-5 pb-5">{children}</div>}
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3 max-sm:[&>*]:h-11 max-sm:[&>*]:flex-1">{footer}</footer>
    </>
  );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade" />
        <Dialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className="fixed inset-x-0 top-[12vh] z-50 mx-auto flex max-h-[76vh] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-popover outline-none animate-pop max-sm:top-[8vh]"
        >
          <header className="flex shrink-0 items-start gap-3 px-5 pt-5 pb-4">
            {Icon && (
              <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-2" aria-hidden>
                <Icon className="size-4" />
              </span>
            )}
            <div className={clsx("min-w-0 flex-1 space-y-1", Icon && "pt-1")}>
              <Dialog.Title className="text-heading">{title}</Dialog.Title>
              {description && <Dialog.Description className="text-small text-muted">{description}</Dialog.Description>}
            </div>
            <Dialog.Close aria-label="Close" className="-mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink max-sm:size-10">
              <X className="size-4" />
            </Dialog.Close>
          </header>
          {onSubmit ? (
            <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
              {body}
            </form>
          ) : (
            body
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
