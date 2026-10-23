/** A segmented control (radio group): one choice among a few, arrow keys move between them. */
import { clsx } from "clsx";
import type { KeyboardEvent, ReactNode } from "react";

interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly count?: number;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  /** Wrap onto more rows when the options do not fit, instead of running off the edge. */
  wrap?: boolean;
  /** At least 44px tall on a phone (below md), for a finger; a desktop keeps its density. */
  touch?: boolean;
  className?: string;
}

export function Segmented<T extends string>({ value, options, onChange, label, wrap = false, touch = false, className }: SegmentedProps<T>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={clsx(wrap ? "flex flex-wrap items-center gap-0.5" : clsx("inline-flex h-7 items-center gap-0.5", touch && "max-md:h-12"), "rounded-md bg-raised p-0.5", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            className={clsx(
              "inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-small font-medium transition-colors duration-100",
              touch && "max-md:h-11 max-md:px-3",
              active ? "bg-surface text-ink shadow-raise" : "text-muted hover:text-ink",
            )}
          >
            {option.label}
            {option.count !== undefined && <span className={clsx("tabular text-caption", active ? "text-muted" : "text-faint")}>{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
