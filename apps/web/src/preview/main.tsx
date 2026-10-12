/**
 * The preview frame (preview.html?c=<component>&scheme=light|dark, or ?screen=<screen> for the
 * style editor's representative screens). It renders the demo the design repo ships next to
 * the component's contract (`<name>.demo.tsx`, copied into the snapshot by `pnpm data`),
 * reports its height to the hub and, on request, switches scheme, overrides CSS variables
 * (the style editor's unsaved edits) and pins an interaction state, so the frame never reloads.
 */
import { type ComponentType, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PINNED_STATES, pinState, type PinnedState } from "./pin.ts";
import { PREVIEW_SCREENS, type PreviewScreen, type PreviewToken, type PreviewVars, type ToFrame } from "./protocol.ts";
import { Screen } from "./screens.tsx";
import "./preview.css";

type Scheme = "light" | "dark";
type DemoModule = { default: ComponentType };

const DEMOS: Readonly<Record<string, () => Promise<DemoModule>>> = Object.fromEntries(
  Object.entries(import.meta.glob<DemoModule>("@snapshot/preview/components/*.demo.tsx")).map(([path, load]) => [path.split("/").at(-1)!.replace(/\.demo\.tsx$/, ""), load]),
);

const params = new URLSearchParams(location.search);
const name = params.get("c") ?? "";
const screen = PREVIEW_SCREENS.find((s) => s.value === params.get("screen"))?.value ?? null;
const initialScheme: Scheme = params.get("scheme") === "dark" ? "dark" : "light";
const SCOPE = ".system-scope";

/** The content's own height (scrollHeight would never shrink below the frame's current height). */
function postHeight(): void {
  const content = document.querySelector(SCOPE);
  if (window.parent !== window && content) window.parent.postMessage({ type: "yx-preview-size", height: content.getBoundingClientRect().height }, location.origin);
}

/** The demo for `name`: undefined while it loads, null when the design repo has none. */
function useDemo(): ComponentType | null | undefined {
  const [demo, setDemo] = useState<ComponentType | null | undefined>(() => (DEMOS[name] ? undefined : null));
  useEffect(() => {
    const load = DEMOS[name];
    if (!load) return;
    let live = true;
    load().then(
      (module) => live && setDemo(() => module.default),
      () => live && setDemo(null),
    );
    return () => {
      live = false;
    };
  }, []);
  return demo;
}

/** Set the overrides for the scheme on show on the system's root, replacing the previous ones. */
function useOverrides(scheme: Scheme, vars: PreviewVars | null): void {
  const applied = useRef<string[]>([]);
  useEffect(() => {
    const scope = document.querySelector<HTMLElement>(SCOPE);
    if (!scope) return;
    for (const property of applied.current) scope.style.removeProperty(property);
    const next = vars?.[scheme] ?? {};
    for (const [property, value] of Object.entries(next)) if (property.startsWith("--")) scope.style.setProperty(property, value);
    applied.current = Object.keys(next);
  }, [scheme, vars]);
}

function Frame() {
  const [scheme, setScheme] = useState<Scheme>(initialScheme);
  const [vars, setVars] = useState<PreviewVars | null>(null);
  const [pinned, setPinned] = useState<PinnedState | null>(null);
  const [tokens, setTokens] = useState<readonly PreviewToken[]>([]);
  const [replay, setReplay] = useState(0);
  const Demo = useDemo();
  useOverrides(scheme, vars);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      const data = event.data as Partial<ToFrame> & Record<string, unknown>;
      if (data.type === "yx-preview-scheme" && (data.scheme === "light" || data.scheme === "dark")) setScheme(data.scheme);
      if (data.type === "yx-preview-vars" && typeof data.vars === "object" && data.vars !== null) setVars(data.vars as PreviewVars);
      if (data.type === "yx-preview-state") setPinned(PINNED_STATES.includes(data.state as PinnedState) ? (data.state as PinnedState) : null);
      if (data.type === "yx-preview-tokens" && Array.isArray(data.tokens)) setTokens(data.tokens as PreviewToken[]);
      if (data.type === "yx-preview-replay") setReplay((n) => n + 1);
    };
    window.addEventListener("message", onMessage);
    // Ask for the current scheme now that the listener exists; a toggle sent while loading would be lost.
    if (window.parent !== window) window.parent.postMessage({ type: "yx-preview-ready" }, location.origin);
    const observer = new ResizeObserver(postHeight);
    const content = document.querySelector(SCOPE);
    if (content) observer.observe(content);
    return () => {
      window.removeEventListener("message", onMessage);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.colorScheme = scheme;
  }, [scheme]);

  useEffect(() => {
    const scope = document.querySelector<HTMLElement>(SCOPE);
    if (scope) pinState(scope, pinned);
  }, [pinned]);

  const ready = screen ? true : Demo !== undefined;
  return (
    <div className="system-scope" data-scheme={scheme} data-preview-ready={ready ? "" : undefined}>
      <div className="p-8 phone:p-5">
        {screen ? (
          <Screen screen={screen as PreviewScreen} tokens={tokens} demos={DEMOS} replay={replay} />
        ) : Demo ? (
          <Demo />
        ) : Demo === null ? (
          <p className="opacity-70">The design repo has no preview for “{name}” yet: add {name}.demo.tsx beside its contract.</p>
        ) : null}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("preview.html is missing #root");
createRoot(root).render(
  <StrictMode>
    <Frame />
  </StrictMode>,
);
