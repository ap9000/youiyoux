/** Form fields: a label above, an optional hint below, and inputs styled like the search field. */
import { clsx } from "clsx";
import { useId, type ComponentProps, type ReactNode } from "react";

const CONTROL = "w-full rounded-md border border-line bg-surface px-2.5 text-body text-ink outline-none transition-colors duration-100 placeholder:text-faint hover:border-line-strong focus:border-accent disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted";

interface FieldProps {
  label: string;
  hint?: ReactNode;
  /** Shown instead of the hint, in the danger colour. */
  error?: string | undefined;
  className?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

export function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={clsx("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-small font-medium text-ink-2">
        {label}
      </label>
      {children(id, note ? noteId : undefined)}
      {note && (
        <p id={noteId} className={clsx("text-small", error ? "text-danger" : "text-muted")}>
          {note}
        </p>
      )}
    </div>
  );
}

export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <input type="text" spellCheck={false} autoComplete="off" className={clsx(CONTROL, "h-8", className)} {...props} />;
}

export function TextArea({ className, rows = 3, ...props }: ComponentProps<"textarea">) {
  return <textarea rows={rows} className={clsx(CONTROL, "resize-y py-1.5", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={clsx(CONTROL, "h-8 pr-7", className)} {...props} />;
}

export function Checkbox({ label, className, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className={clsx("inline-flex cursor-pointer items-center gap-2 text-body text-ink-2 has-disabled:cursor-not-allowed has-disabled:opacity-60", className)}>
      <input type="checkbox" className="size-3.5 accent-accent" {...props} />
      {label}
    </label>
  );
}
