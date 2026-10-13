import type { ComponentProps } from "react";
export function IconButton({ children, ...props }: ComponentProps<"button">) {
  return <button type="button" {...props}><svg aria-hidden="true" width="20" height="20"><path d="M2 10h16M10 2v16" stroke="currentColor" /></svg></button>;
}
