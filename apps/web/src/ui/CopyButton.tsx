/** Copy a value; the icon confirms and screen readers hear "Copied". */
import { clsx } from "clsx";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const CONFIRM_MS = 1200;

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = (): void => {
    navigator.clipboard.writeText(value).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={state === "failed" ? "Copy failed: the browser blocked the clipboard" : label}
      className={clsx("grid size-6 shrink-0 place-items-center rounded-sm text-muted transition-colors duration-100 hover:bg-raised hover:text-ink", className)}
    >
      {state === "copied" ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
