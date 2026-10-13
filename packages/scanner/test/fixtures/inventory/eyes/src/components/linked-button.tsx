import type { ComponentProps } from "react";
export function LinkedButton(props: ComponentProps<"button">) { return <button {...props}><svg aria-hidden="true" width="20" height="20" /></button>; }
