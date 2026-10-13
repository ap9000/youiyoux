import { Toaster } from "@/components/ui/sonner";
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}<Toaster /></body>
    </html>
  );
}
