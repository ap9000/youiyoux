import * as React from "react";
import { cn } from "~/lib/utils";

function Button({ className, ...props }: React.ComponentProps<"button">) {
  return <button data-slot="button" className={cn("inline-flex items-center rounded-md px-4 text-sm font-medium", className)} {...props} />;
}

export { Button };
