/**
 * The one confirmation a style draft needs when it puts colour pairs below WCAG AA that passed
 * before: it names every such pair, and confirming sends exactly their keys with the approval.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { StyleContrast } from "../../data/workflow.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";

const KIND = { text: "text", large: "large text", ui: "UI part" } as const;

export function ContrastConfirm({ failing, revision, onConfirm, onClose }: { failing: readonly StyleContrast[]; revision: number; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade" />
        <Dialog.Content className="fixed inset-x-0 top-[10vh] z-50 mx-auto flex max-h-[80vh] w-[min(560px,calc(100vw-24px))] flex-col rounded-xl border border-line bg-surface shadow-popover outline-none animate-pop">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-5">
            <TriangleAlert aria-hidden className="size-4 text-danger" />
            <Dialog.Title className="text-heading">Approve with {failing.length} contrast failure(s)?</Dialog.Title>
            <Dialog.Close aria-label="Close" className="ml-auto grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink">
              <X className="size-4" />
            </Dialog.Close>
          </header>
          <div className="min-h-0 space-y-3 overflow-y-auto p-5">
            <Dialog.Description className="text-small text-ink-2">
              Revision {revision} puts these colour pairs below WCAG AA. Each passed before this draft, or did not exist. Approving records that you accepted exactly these pairs, and the review branch's commit names them.
            </Dialog.Description>
            <ul aria-label="Colour pairs this draft puts below WCAG AA" className="divide-y divide-line overflow-hidden rounded-md border border-line">
              {failing.map((c) => (
                <li key={c.key} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-small text-ink">{c.label}</span>
                    <span className="block text-caption text-muted">
                      <span className="capitalize">{c.scheme}</span> · {KIND[c.kind]} · needs {c.required}:1{c.before !== null ? ` · was ${c.before.toFixed(2)}:1` : " · new pair"}
                      {c.unreadable && <span className="block text-danger">{c.unreadable}</span>}
                    </span>
                  </span>
                  <span className="tabular font-mono text-mono-sm text-ink">{c.after === null ? "?" : `${c.after.toFixed(2)}:1`}</span>
                  <Badge tone="danger">{c.after === null ? "Unreadable" : "Below AA"}</Badge>
                </li>
              ))}
            </ul>
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
            <Dialog.Close asChild>
              <Button autoFocus>Keep editing</Button>
            </Dialog.Close>
            <Button variant="primary" onClick={onConfirm}>
              <ShieldCheck /> Approve with these {failing.length} failure(s)
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
