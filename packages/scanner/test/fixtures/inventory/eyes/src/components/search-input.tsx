import type { ComponentProps } from "react";

export function SearchInput(props: ComponentProps<"input">) {
  return <input type="search" aria-label="Search" placeholder="Search" className="h-9 w-64 rounded-md border border-slate-400 bg-white px-3 text-sm text-slate-900" {...props} />;
}
