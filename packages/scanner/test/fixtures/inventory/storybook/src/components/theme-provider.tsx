import type { ReactNode } from "react";

/** The app's own theme switch: a provider that only sets a data attribute. */
export function ThemeProvider({ theme, children }: { theme: "default" | "contrast"; children: ReactNode }) {
  return <div data-theme={theme}>{children}</div>;
}
