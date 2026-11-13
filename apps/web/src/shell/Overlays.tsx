/** Hosts the command palette, the shortcuts sheet and Connect your agent; each loads on first use (the first two also on idle). */
import { Suspense } from "react";
import { preloadable } from "../app/routes.tsx";
import { overlayOpener, setOverlay, useOverlay } from "./keyboard.ts";

const palette = preloadable(() => import("./CommandPalette.tsx"), (m) => m.CommandPalette);
const cheatSheet = preloadable(() => import("./CheatSheet.tsx"), (m) => m.CheatSheet);
const CommandPalette = palette.Component;
const CheatSheet = cheatSheet.Component;
const ConnectAgents = preloadable(() => import("./ConnectAgents.tsx"), (m) => m.ConnectAgents).Component;

export function preloadOverlays(): void {
  void palette.preload();
  void cheatSheet.preload();
}

const close = (): void => setOverlay(null);

export function Overlays() {
  const overlay = useOverlay();
  // Each gives focus back to what had it when the first of them opened (a rail button, say).
  const opener = overlayOpener();
  return (
    <Suspense fallback={null}>
      {overlay === "palette" && <CommandPalette onClose={close} returnFocusTo={opener} />}
      {overlay === "help" && <CheatSheet onClose={close} returnFocusTo={opener} />}
      {overlay === "agents" && <ConnectAgents onClose={close} returnFocusTo={opener} />}
    </Suspense>
  );
}
