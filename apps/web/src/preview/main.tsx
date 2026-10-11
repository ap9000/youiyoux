/**
 * The preview frame (preview.html?c=<component>&scheme=light|dark). It renders the demo the
 * design repo ships next to the component's contract (`<name>.demo.tsx`, copied into the
 * snapshot by `pnpm data`), reports its height to the hub and switches scheme on request,
 * so the frame never reloads.
 */
import { type ComponentType, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./preview.css";

type Scheme = "light" | "dark";
type DemoModule = { default: ComponentType };

const DEMOS: Readonly<Record<string, () => Promise<DemoModule>>> = Object.fromEntries(
  Object.entries(import.meta.glob<DemoModule>("@snapshot/preview/components/*.demo.tsx")).map(([path, load]) => [path.split("/").at(-1)!.replace(/\.demo\.tsx$/, ""), load]),
);

const params = new URLSearchParams(location.search);
const name = params.get("c") ?? "";
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

function Frame() {
  const [scheme, setScheme] = useState<Scheme>(initialScheme);
  const Demo = useDemo();

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      const data = event.data as { type?: unknown; scheme?: unknown };
      if (data.type === "yx-preview-scheme" && (data.scheme === "light" || data.scheme === "dark")) setScheme(data.scheme);
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

  return (
    <div className="system-scope" data-scheme={scheme} data-preview-ready={Demo === undefined ? undefined : ""}>
      <div className="p-8 phone:p-5">{Demo ? <Demo /> : Demo === null ? <p className="opacity-70">The design repo has no preview for “{name}” yet: add {name}.demo.tsx beside its contract.</p> : null}</div>
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
