/** A pane's search field. `/` focuses it from anywhere; Escape clears, then leaves. */
import { clsx } from "clsx";
import { Search, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Kbd } from "./Kbd.tsx";

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}

export function SearchField({ value, onChange, placeholder, label, className }: SearchFieldProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape") return;
    if (value) onChange("");
    else event.currentTarget.blur();
  };
  return (
    <div className={clsx("relative flex items-center", className)}>
      <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-muted" />
      <input
        data-pane-search
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="h-7 w-full rounded-md border border-line bg-surface pr-8 pl-7 text-body text-ink transition-colors duration-100 placeholder:text-muted hover:border-line-strong focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value ? (
        <button type="button" aria-label="Clear search" onClick={() => onChange("")} className="absolute right-1.5 grid size-5 place-items-center rounded-xs text-muted hover:bg-raised hover:text-ink">
          <X className="size-3" />
        </button>
      ) : (
        <Kbd aria-hidden className="pointer-events-none absolute right-1.5">
          /
        </Kbd>
      )}
    </div>
  );
}
