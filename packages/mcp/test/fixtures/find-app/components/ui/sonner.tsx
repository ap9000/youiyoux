"use client";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  return <Sonner className="toaster group" position="bottom-right" {...props} />;
}

export { Toaster, toast };
