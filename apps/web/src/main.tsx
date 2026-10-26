import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { sessionKey } from "./data/session-key.ts";
import { startModel } from "./data/store.ts";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");
// The hosted hub (youiyoux hub serve) names its API here: it shows the organisation, and no snapshot is read.
const org = document.querySelector<HTMLMetaElement>('meta[name="youi-org"]')?.content;
// With workspaces, people sign in with GitHub and see each workspace they are a member of.
const workspaces = document.querySelector<HTMLMetaElement>('meta[name="youi-org-mode"]')?.content === "workspaces";
if (org) {
  void import("./org/OrgApp.tsx").then(({ OrgApp }) =>
    createRoot(root).render(
      <StrictMode>
        <OrgApp api={org} mode={workspaces ? "workspaces" : "key"} />
      </StrictMode>,
    ),
  );
} else {
  // Fetch the snapshot while React mounts; on repeat visits it comes from Cache Storage.
  startModel();
  // Keep the rule editor's key from the link `youiyoux ui` printed, whichever page it opens.
  sessionKey();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
