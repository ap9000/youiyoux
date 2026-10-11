import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { startModel } from "./data/store.ts";
import "./styles/app.css";

// Fetch the snapshot while React mounts; on repeat visits it comes from Cache Storage.
startModel();

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
