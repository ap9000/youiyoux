import type { ComponentProps } from "react";

const VARIANTS = {
  solid: "bg-blue-700 text-white",
  outline: "border border-slate-400 text-slate-900 dark:text-slate-100",
};

export function Button({ variant = "solid", className = "", ...props }: ComponentProps<"button"> & { variant?: keyof typeof VARIANTS }) {
  return <button type="button" className={`inline-flex h-9 items-center rounded-md px-4 text-sm font-medium ${VARIANTS[variant]} ${className}`} {...props} />;
}
