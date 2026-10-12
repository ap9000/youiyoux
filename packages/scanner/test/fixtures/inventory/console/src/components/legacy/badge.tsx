import type { ComponentProps } from "react";

/** The legacy kit's badge: same name as the CVA kit's. */
export function Badge(props: ComponentProps<"span">) {
  return <span className="lg-badge" {...props} />;
}
