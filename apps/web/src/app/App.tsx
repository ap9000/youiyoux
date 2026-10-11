/** The app shell: nav rail, one inset content sheet, lazy routes, global keys and overlays. */
import { Suspense, useEffect, useLayoutEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { startUsage, useModelState } from "../data/store.ts";
import { markNavigation, settleNavigation } from "../lib/perf.ts";
import { useGlobalKeys } from "../shell/keyboard.ts";
import { NavRail } from "../shell/NavRail.tsx";
import { Overlays, preloadOverlays } from "../shell/Overlays.tsx";
import { PaneSkeleton, ScreenBoundary } from "../ui/Pane.tsx";
import { AccessScreen, CatalogScreen, ChangesScreen, HomeScreen, NotFoundScreen, preload, preloadAll, ScreensScreen, TokensScreen } from "./routes.tsx";

const IDLE_TIMEOUT_MS = 1500;

/** Inside the route boundary: runs once the new route has committed, ending the navigation sample. */
function NavigationSettled() {
  const [location] = useLocation();
  useLayoutEffect(() => settleNavigation(location), [location]);
  return null;
}

function anchorOf(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest<HTMLAnchorElement>("a[href^='/']") : null;
}

/** Hovering or focusing a link starts loading its route; clicking one starts a navigation sample. */
function useLinkIntent(): void {
  useEffect(() => {
    const onIntent = (event: Event): void => {
      const anchor = anchorOf(event.target);
      if (anchor) preload(anchor.pathname);
    };
    const onClick = (event: MouseEvent): void => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = anchorOf(event.target);
      if (anchor && anchor.pathname !== location.pathname) markNavigation(anchor.pathname);
    };
    document.addEventListener("pointerover", onIntent, { passive: true });
    document.addEventListener("focusin", onIntent);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointerover", onIntent);
      document.removeEventListener("focusin", onIntent);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
}

/** After first paint, quietly fetch every other route, the palette and the usage map, and start the search worker. */
function useIdleWarmup(): void {
  const model = useModelState();
  const ready = model.status === "ready" ? model.value : null;
  useEffect(() => {
    if (!ready) return;
    const warm = (): void => {
      preloadAll();
      preloadOverlays();
      startUsage();
      void import("../search/client.ts").then(({ searchClient }) => searchClient(ready));
    };
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(warm, { timeout: IDLE_TIMEOUT_MS });
      return () => cancelIdleCallback(id);
    }
    const timer = setTimeout(warm, IDLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready]);
}

export function App() {
  const [location, navigate] = useLocation();
  useGlobalKeys(navigate);
  useLinkIntent();
  useIdleWarmup();
  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <NavRail />
      <main className="flex min-w-0 flex-1 py-1.5 pr-1.5 max-md:p-0">
        <div className="relative flex min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface shadow-raise max-md:rounded-none max-md:border-y-0 max-md:border-r-0">
          <ScreenBoundary resetKey={location}>
            <Suspense fallback={<PaneSkeleton />}>
              <NavigationSettled />
              <Switch>
                <Route path="/" component={HomeScreen} />
                <Route path="/elements/*?" component={CatalogScreen} />
                <Route path="/tokens/*?" component={TokensScreen} />
                <Route path="/screens/*?" component={ScreensScreen} />
                <Route path="/changes" component={ChangesScreen} />
                <Route path="/access" component={AccessScreen} />
                <Route component={NotFoundScreen} />
              </Switch>
            </Suspense>
          </ScreenBoundary>
        </div>
      </main>
      <ScreenBoundary resetKey={location}>
        <Overlays />
      </ScreenBoundary>
    </div>
  );
}
