import type { ReactNode } from "react";

export interface AlertProps {
  tone?: "info" | "warning" | "danger";
  title: string;
  children?: ReactNode;
  onDismiss?: () => void;
}

/** A banner across the top of a panel; hand-rolled. */
export function Alert({ tone = "info", title, children, onDismiss }: AlertProps) {
  return (
    <div role="alert" className={`rounded-md border p-4 alert-${tone}`}>
      <strong>{title}</strong>
      {children}
      {onDismiss ? <button type="button" aria-label="Dismiss" onClick={onDismiss}>×</button> : null}
    </div>
  );
}

/** A helper beside the component: it never answers for Alert. */
export function alertTone(tone: AlertProps["tone"]): string {
  return `alert-${tone ?? "info"}`;
}
