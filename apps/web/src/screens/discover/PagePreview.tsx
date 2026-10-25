/**
 * A block (a sign-in page, a dashboard, a chart card) drawn as the page it is, in the user's theme:
 * at a desktop's or a phone's width, light or dark, scaled down to fit, and scrollable inside its
 * frame. The drawing is static (no script, as every specimen frame); Try it swaps in the live
 * bundle, sandboxed as Try it always is, so its menus and toggles work. Fullscreen shows it at
 * full size in a dialog of its own (Escape closes it, focus goes back to the button).
 */
import * as Dialog from "@radix-ui/react-dialog";
import { Maximize2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Scheme } from "../../app/theme.tsx";
import type { PreviewAnswer } from "../../data/discover-preview.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { frameDocument, PAGE_HEIGHT, PAGE_WIDTH } from "../inventory/Specimens.tsx";
import { LIVE_SANDBOX, liveDocument } from "../inventory/try-live.tsx";
import { SCHEME_BACKDROP } from "./CandidatePanel.tsx";

export type PageSize = "desktop" | "phone";

/** The page's viewport at each size. */
export const PAGE_SIZES: Readonly<Record<PageSize, { readonly width: number; readonly height: number; readonly label: string }>> = {
  desktop: { width: PAGE_WIDTH, height: PAGE_HEIGHT, label: "Desktop" },
  phone: { width: 390, height: 844, label: "Phone" },
};

/** The tallest a page is drawn in the drawer, so a phone's page does not run past the drawer's fold. */
const MAX_DRAWER_HEIGHT = 560;

/** The scale that fits a `size` page in `width` × `height` (never above full size). */
export function pageScale(size: PageSize, width: number, height = Number.POSITIVE_INFINITY): number {
  const page = PAGE_SIZES[size];
  return Math.max(0.1, Math.min(1, width / page.width, height / page.height));
}

/** The width an element has, kept up to date. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** One page frame: static, or live once Try it is on. Escape pressed inside a live page reaches `onEscape` (the frame keeps the key). */
function PageFrame({ answer, html, size, scheme, live, scale, onEscape }: { answer: PreviewAnswer; html: string; size: PageSize; scheme: Scheme; live: boolean; scale: number; onEscape: () => void }) {
  const page = PAGE_SIZES[size];
  const css = answer.css![scheme];
  const frameRef = useRef<HTMLIFrameElement>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    if (!live) return;
    const onMessage = (event: MessageEvent): void => {
      // Only this frame's own window: its origin is opaque, so the source is what identifies it.
      if (event.source === null || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { youi?: unknown; type?: unknown } | null;
      if (data?.youi === "try" && data.type === "escape") escape.current();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [live]);
  return (
    <div className="overflow-hidden rounded-md border border-line" style={{ width: page.width * scale, height: page.height * scale, background: SCHEME_BACKDROP[scheme] }}>
      <iframe
        ref={frameRef}
        // A new document per size, scheme and mode, so nothing of the last one carries over.
        key={`${size}:${scheme}:${live ? "live" : "static"}`}
        title={`${answer.name}, ${page.label.toLowerCase()}, ${scheme}${live ? ", live" : ""}`}
        sandbox={live ? LIVE_SANDBOX : "allow-same-origin"}
        srcDoc={live && answer.script ? liveDocument("", css, scheme, answer.script, true) : frameDocument(html, css, scheme, true)}
        data-page-frame={size}
        data-live={live || undefined}
        className="origin-top-left border-0"
        style={{ width: page.width, height: page.height, transform: `scale(${scale})`, colorScheme: scheme }}
      />
    </div>
  );
}

function Controls({ size, onSize, scheme, onScheme, live, onLive, tryable }: { size: PageSize; onSize: (size: PageSize) => void; scheme: Scheme; onScheme: (scheme: Scheme) => void; live: boolean; onLive: (live: boolean) => void; tryable: boolean }) {
  return (
    <>
      <Segmented label="Width" value={size} onChange={onSize} touch options={(["desktop", "phone"] as const).map((value) => ({ value, label: PAGE_SIZES[value].label }))} />
      <Segmented label="Scheme" value={scheme} onChange={onScheme} touch options={[{ value: "light" as const, label: "Light" }, { value: "dark" as const, label: "Dark" }]} />
      {tryable && (
        <Button variant={live ? "primary" : "outline"} size="sm" aria-pressed={live} onClick={() => onLive(!live)} className="max-md:h-11">
          {live ? "Done" : "Try it"}
        </Button>
      )}
    </>
  );
}

export function PagePreview({ answer, html, scheme: hubScheme }: { answer: PreviewAnswer; html: string; scheme: Scheme }) {
  const [size, setSize] = useState<PageSize>("desktop");
  const [scheme, setScheme] = useState<Scheme>(hubScheme);
  const [live, setLive] = useState(false);
  const [full, setFull] = useState(false);
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const tryable = answer.script !== null;
  const controls = <Controls size={size} onSize={setSize} scheme={scheme} onScheme={setScheme} live={live} onLive={setLive} tryable={tryable} />;
  return (
    <div className="space-y-2" data-page-preview={answer.id}>
      <div className="flex flex-wrap items-center gap-2">
        {controls}
        <Dialog.Root open={full} onOpenChange={setFull}>
          <Dialog.Trigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto max-md:h-11" aria-label={`Show ${answer.entry.title ?? answer.name} full size`}>
              <Maximize2 aria-hidden /> Full size
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
            <Dialog.Content className="fixed inset-0 z-50 flex flex-col bg-surface outline-none" data-testid="page-fullscreen">
              <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
                <Dialog.Title className="mr-2 text-heading text-ink">{answer.entry.title ?? answer.name}</Dialog.Title>
                <Dialog.Description className="sr-only">The block at full size in your theme</Dialog.Description>
                {controls}
                <Dialog.Close asChild>
                  <Button variant="ghost" size="icon" className="ml-auto max-md:size-11" aria-label="Close full size">
                    <X aria-hidden />
                  </Button>
                </Dialog.Close>
              </header>
              <FullStage answer={answer} html={html} size={size} scheme={scheme} live={live} onEscape={() => setFull(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      <div ref={boxRef} className="flex justify-center">
        {width > 0 && !full && <PageFrame answer={answer} html={html} size={size} scheme={scheme} live={live} scale={pageScale(size, width, MAX_DRAWER_HEIGHT)} onEscape={() => setLive(false)} />}
      </div>
    </div>
  );
}

/** The page in the fullscreen dialog: as large as the window lets it be, never above full size. */
function FullStage({ answer, html, size, scheme, live, onEscape }: { answer: PreviewAnswer; html: string; size: PageSize; scheme: Scheme; live: boolean; onEscape: () => void }) {
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => setHeight(boxRef.current?.clientHeight ?? 0), [boxRef, width]);
  return (
    <div ref={boxRef} className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-4">
      {width > 0 && <PageFrame answer={answer} html={html} size={size} scheme={scheme} live={live} scale={pageScale(size, width - 32, height > 0 ? height - 32 : undefined)} onEscape={onEscape} />}
    </div>
  );
}
