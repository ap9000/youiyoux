/**
 * A side drawer on a desktop and a bottom sheet on a phone, on Radix Dialog (focus trap, Escape
 * closes, focus goes back). The sheet follows a finger dragged down from its top bar and closes
 * when let go past a third of its height or flicked faster than 0.11 px/ms (shouldDismiss);
 * otherwise it settles back. Motion is in styles/inventory.css: transform and opacity only.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { shouldDismiss } from "../../data/inventory-view.ts";

const WIDE = "(min-width: 768px)";

/** True at the md breakpoint and up (a drawer); false below it (a bottom sheet). Without matchMedia, wide. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof matchMedia !== "function") return () => {};
      const query = matchMedia(WIDE);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => (typeof matchMedia === "function" ? matchMedia(WIDE).matches : true),
  );
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: "drawer" | "sheet";
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  /** Large: a sheet nearly the whole phone's height and a wider drawer, for something to see at size (a Discover item running live). */
  size?: "default" | "large";
}

/** Drag samples kept for the release velocity: the last this many milliseconds. */
const VELOCITY_WINDOW_MS = 80;

export function Sheet({ open, onOpenChange, variant, title, description, children, footer, testId, size = "default" }: SheetProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; startY: number; samples: Array<{ y: number; t: number }> } | null>(null);
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const sheet = variant === "sheet";
  // The element that opened the sheet. The sheet is controlled (no Dialog.Trigger), so Radix has
  // nothing to return focus to; remember the opener and give focus back to it on close.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) opener.current = document.activeElement;
  }, [open]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!sheet || (event.pointerType === "mouse" && event.button !== 0)) return;
    if ((event.target as Element).closest("button, a, input")) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { id: event.pointerId, startY: event.clientY, samples: [{ y: event.clientY, t: event.timeStamp }] };
    setSettling(false);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    d.samples = [...d.samples.filter((s) => event.timeStamp - s.t <= VELOCITY_WINDOW_MS), { y: event.clientY, t: event.timeStamp }];
    setOffset(Math.max(0, event.clientY - d.startY));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    const first = d.samples[0]!;
    const elapsed = event.timeStamp - first.t;
    const velocity = elapsed > 0 ? (event.clientY - first.y) / elapsed : 0;
    const distance = Math.max(0, event.clientY - d.startY);
    if (shouldDismiss({ distance, height: contentRef.current?.offsetHeight ?? 0, velocity })) onOpenChange(false);
    else {
      setSettling(true);
      setOffset(0);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (setOffset(0), onOpenChange(next))}>
      <Dialog.Portal>
        <Dialog.Overlay className="inv-scrim fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          ref={contentRef}
          data-variant={variant}
          data-size={size}
          data-testid={testId}
          className={clsx(
            "inv-drawer fixed z-50 flex flex-col border-line bg-surface shadow-popover outline-none",
            sheet ? clsx("inset-x-0 bottom-0 rounded-t-xl border-t", size === "large" ? "h-[94dvh]" : "max-h-[88dvh]") : clsx("inset-y-0 right-0 border-l", size === "large" ? "w-[min(760px,100vw)]" : "w-[min(560px,100vw)]"),
            settling && "inv-settle",
          )}
          style={offset > 0 || settling ? { transform: `translate3d(0, ${offset}px, 0)` } : undefined}
          onTransitionEnd={() => setSettling(false)}
          onCloseAutoFocus={(event) => {
            const target = opener.current;
            opener.current = null;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <div className={clsx("shrink-0 border-b border-line", sheet && "touch-none select-none")} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} data-testid={sheet ? "sheet-handle" : undefined}>
            {sheet && <div aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-full bg-line-strong" />}
            <header className="flex min-h-12 items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <Dialog.Title className="text-heading text-ink">{title}</Dialog.Title>
                {description ? <Dialog.Description className="text-small text-muted">{description}</Dialog.Description> : <Dialog.Description className="sr-only">Details</Dialog.Description>}
              </div>
              <Dialog.Close aria-label="Close" className="inv-press grid size-7 shrink-0 place-items-center rounded-md text-muted max-md:-my-2 max-md:-mr-2 max-md:size-11">
                <X className="size-4" />
              </Dialog.Close>
            </header>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer && <div className="shrink-0 border-t border-line px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
