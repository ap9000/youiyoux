/**
 * The preview frame (preview.html?c=<component>&scheme=light|dark). It reports its
 * height to the hub and switches scheme on request, so the frame never reloads.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEMOS } from "./demos.tsx";
import "./preview.css";

type Scheme = "light" | "dark";

const params = new URLSearchParams(location.search);
const name = params.get("c") ?? "";
const initialScheme: Scheme = params.get("scheme") === "dark" ? "dark" : "light";

/** The content's own height (scrollHeight would never shrink below the frame's current height). */
function postHeight(): void {
  const content = document.querySelector(".signal-scope");
  if (window.parent !== window && content) window.parent.postMessage({ type: "yx-preview-size", height: content.getBoundingClientRect().height }, location.origin);
}

function Frame() {
  const [scheme, setScheme] = useState<Scheme>(initialScheme);
  const Demo = DEMOS[name];

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
    const content = document.querySelector(".signal-scope");
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
    <div className="signal-scope" data-scheme={scheme} data-preview-ready={Demo ? "" : undefined}>
      <div className="p-8 phone:p-5">{Demo ? <Demo /> : <p className="text-muted-foreground">No preview is written for “{name}” yet.</p>}</div>
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
