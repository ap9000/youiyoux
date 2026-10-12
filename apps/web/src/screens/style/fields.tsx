/**
 * The style editor's inputs, built on the hub's field style. Every one is keyboard first:
 * numbers step with ↑/↓ (Shift ×10), Escape puts a field back to the value it had when it took
 * focus, and nothing commits on blur alone: each valid keystroke shows in the preview at once.
 */
import { clsx } from "clsx";
import { RotateCcw } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { formatCssColor, parseCssColor, toHex, type DtcgColor } from "@youiyoux/tokens/color";
import { CONTROL } from "../../ui/Field.tsx";
import { Swatch } from "../../ui/Swatch.tsx";

/** The hub's field style, sized by each control rather than its row. */
export const INPUT = CONTROL.replace("w-full ", "");

/** A labelled row: the label on the left at a desk, above on a phone. */
export function Row({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 max-sm:grid-cols-1">
      <label htmlFor={htmlFor} className="text-small text-muted">
        {label}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</div>
      {hint && <p className="col-start-2 text-caption text-muted max-sm:col-start-1">{hint}</p>}
    </div>
  );
}

const round = (value: number, step: number): number => {
  const places = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(value.toFixed(Math.min(places + 1, 4)));
};

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

/** A number: type it, or step it with ↑/↓ (Shift ×10). Escape restores the value it had on focus. */
export function NumberField({ label, value, onChange, step = 1, min, max, unit, className, disabled, id }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  const focusValue = useRef(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current || Number(text) !== value) setText(String(value));
    // Only an outside change (another control, a reset) rewrites what is being typed.
  }, [value]);
  const clamp = (n: number): number => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));
  const commit = (n: number): void => {
    const next = clamp(round(n, step));
    setText(String(next));
    onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      commit((Number.isFinite(Number(text)) ? Number(text) : value) + (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      commit(focusValue.current);
    }
  };
  return (
    <span className={clsx("relative inline-flex items-center", className)}>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        aria-label={label}
        disabled={disabled}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => {
          focused.current = true;
          focusValue.current = value;
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(value));
        }}
        onChange={(event) => {
          setText(event.target.value);
          const n = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(n) && n === clamp(n)) onChange(n);
        }}
        onKeyDown={onKeyDown}
        className={clsx(INPUT, "h-7 w-[5.5rem] tabular", unit && "pr-8")}
      />
      {unit && <span className="pointer-events-none absolute right-2 text-caption text-muted">{unit}</span>}
    </span>
  );
}

/** A colour: a swatch that opens the system picker, and its hex (or rgb()) to type. Alpha is kept. */
export function ColorField({ label, value, onChange, disabled }: { label: string; value: DtcgColor; onChange: (value: DtcgColor) => void; disabled?: boolean }) {
  const css = formatCssColor(value);
  const [text, setText] = useState(css);
  const focusValue = useRef(value);
  const [invalid, setInvalid] = useState(false);
  const id = useId();
  useEffect(() => {
    setText(css);
    setInvalid(false);
  }, [css]);
  const withAlpha = (next: DtcgColor): DtcgColor => (value.alpha !== undefined && next.alpha === undefined ? { colorSpace: next.colorSpace, components: next.components, alpha: value.alpha, ...(next.hex ? { hex: next.hex } : {}) } : next);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <label className="relative grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus">
        <Swatch color={css} size="sm" />
        <input
          type="color"
          aria-label={`${label}: pick`}
          disabled={disabled}
          value={toHex(value)}
          onChange={(event) => {
            const next = parseCssColor(event.target.value);
            if (next) onChange(withAlpha(next));
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <input
        id={id}
        type="text"
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => (focusValue.current = value)}
        onChange={(event) => {
          setText(event.target.value);
          const next = parseCssColor(event.target.value);
          setInvalid(next === null);
          if (next) onChange(next);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onChange(focusValue.current);
          setText(formatCssColor(focusValue.current));
          setInvalid(false);
        }}
        onBlur={() => {
          setText(css);
          setInvalid(false);
        }}
        className={clsx(INPUT, "h-7 w-[11rem] font-mono text-mono-sm max-sm:w-[9.5rem]", invalid && "border-danger")}
      />
    </span>
  );
}

/** Own value, or an alias of another token of the same type. */
export function AliasSelect({ label, value, options, onChange, disabled }: { label: string; value: string | null; options: readonly string[]; onChange: (alias: string | null) => void; disabled?: boolean }) {
  return (
    <select aria-label={label} disabled={disabled} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} className={clsx(INPUT, "h-7 w-auto max-w-[14rem] pr-7 text-small")}>
      <option value="">Own value</option>
      {options.map((path) => (
        <option key={path} value={path}>
          Alias of {path}
        </option>
      ))}
    </select>
  );
}

export function ChoiceField<T extends string | number>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly T[]; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <select aria-label={label} disabled={disabled} value={String(value)} onChange={(event) => onChange(options.find((o) => String(o) === event.target.value) ?? value)} className={clsx(INPUT, "h-7 w-auto pr-7")}>
      {options.map((option) => (
        <option key={String(option)} value={String(option)}>
          {String(option)}
        </option>
      ))}
    </select>
  );
}

export function ResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-6 place-items-center rounded-sm text-muted hover:bg-raised hover:text-ink">
      <RotateCcw className="size-3.5" />
    </button>
  );
}

/** A timing curve: progress (y) over time (x), from evenly spaced samples; overshoot shows above the line at 1. */
export function CurvePlot({ points, label, className }: { points: readonly number[]; label: string; className?: string }) {
  const width = 120;
  const height = 64;
  const low = Math.min(0, ...points);
  const high = Math.max(1, ...points);
  const y = (p: number): number => height - 6 - ((p - low) / (high - low || 1)) * (height - 12);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${((i / (points.length - 1)) * width).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} className={clsx("h-16 w-30 shrink-0 rounded-md border border-line bg-sunken", className)}>
      <line x1="0" x2={width} y1={y(1)} y2={y(1)} className="stroke-line-strong" strokeDasharray="2 3" />
      <line x1="0" x2={width} y1={y(0)} y2={y(0)} className="stroke-line" />
      <path d={path} fill="none" className="stroke-accent" strokeWidth="1.75" strokeLinejoin="round" />
    </svg>
  );
}

/** y over evenly spaced x for a CSS cubic-bezier(x1, y1, x2, y2). */
export function bezierPoints([x1, y1, x2, y2]: readonly [number, number, number, number], samples = 48): number[] {
  const at = (t: number, a: number, b: number): number => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return Array.from({ length: samples + 1 }, (_, i) => {
    const x = i / samples;
    // Solve x(t) = x by bisection: x is monotonic in t for x1, x2 in [0, 1].
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (at(mid, x1, x2) < x) lo = mid;
      else hi = mid;
    }
    return at((lo + hi) / 2, y1, y2);
  });
}
