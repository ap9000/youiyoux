/** Hosts the command palette and the shortcuts sheet; both load on first use (or on idle). */
import { Suspense } from "react";
import { preloadable } from "../app/routes.tsx";
import { setOverlay, useOverlay } from "./keyboard.ts";

const palette = preloadable(() => import("./CommandPalette.tsx"), (m) => m.CommandPalette);
const cheatSheet = preloadable(() => import("./CheatSheet.tsx"), (m) => m.CheatSheet);
const CommandPalette = palette.Component;
const CheatSheet = cheatSheet.Component;

export function preloadOverlays(): void {
  void palette.preload();
  void cheatSheet.preload();
}

const close = (): void => setOverlay(null);

export function Overlays() {
  const overlay = useOverlay();
  return (
    <Suspense fallback={null}>
      {overlay === "palette" && <CommandPalette onClose={close} />}
      {overlay === "help" && <CheatSheet onClose={close} />}
    </Suspense>
  );
}
