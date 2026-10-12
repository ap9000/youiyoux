import * as React from "react";
import { cn } from "~/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card" className={cn("flex flex-col gap-6 rounded-xl border py-6", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-title" className={cn("font-semibold", className)} {...props} />;
}

export { Card, CardTitle };
