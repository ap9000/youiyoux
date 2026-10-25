/**
 * An opened component, running: its bundle in one large frame, sandboxed as Try it always is
 * (`allow-scripts`, never same origin), centred and in the user's theme, light or dark, so its
 * menus open and its fields take typing the moment the drawer opens. Run it again starts it fresh.
 * Only that frame's own messages are read: an error it hit, and an Escape it did not use.
 */
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Scheme } from "../../app/theme.tsx";
import type { PreviewAnswer } from "../../data/discover-preview.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/Segmented.tsx";
import { LIVE_SANDBOX, liveDocument } from "../inventory/try-live.tsx";
import { SCHEME_BACKDROP } from "./CandidatePanel.tsx";

export function Stage({ answer, scheme: hubScheme, onEscape }: { answer: PreviewAnswer & { script: string; css: { light: string; dark: string } }; scheme: Scheme; onEscape: () => void }) {
  const [scheme, setScheme] = useState<Scheme>(hubScheme);
  const [run, setRun] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // Only this frame's own window: its origin is opaque, so the source is what identifies it.
      if (event.source === null || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { youi?: unknown; type?: unknown; message?: unknown } | null;
      if (data?.youi !== "try") return;
      if (data.type === "escape") escape.current();
      else if (data.type === "error") setError(typeof data.message === "string" ? data.message.slice(0, 200) : "an error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const again = (): void => {
    setError(null);
    setRun((n) => n + 1);
  };
  return (
    <div className="space-y-2" data-stage={answer.id}>
      <div className="overflow-hidden rounded-md border border-line" style={{ background: SCHEME_BACKDROP[scheme] }}>
        <iframe
          ref={frameRef}
          // A new document per scheme and per run, so nothing of the last one carries over.
          key={`${scheme}:${run}`}
          title={`${answer.name}, ${scheme}, live`}
          sandbox={LIVE_SANDBOX}
          srcDoc={liveDocument("", answer.css[scheme], scheme, answer.script, "stage")}
          data-stage-frame={scheme}
          className="block h-[min(420px,48dvh)] w-full border-0"
          style={{ colorScheme: scheme }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Scheme"
          value={scheme}
          onChange={(next) => (setError(null), setScheme(next))}
          touch
          options={[
            { value: "light" as const, label: "Light" },
            { value: "dark" as const, label: "Dark" },
          ]}
        />
        <Button variant="ghost" size="sm" onClick={again} className="ml-auto max-md:h-11">
          <RotateCcw aria-hidden /> Run it again
        </Button>
      </div>
      {error && (
        <p className="text-small text-warning" role="status" data-stage-error>
          It failed when it ran ({error}). Run it again, or see it on its registry's site.
        </p>
      )}
    </div>
  );
}
