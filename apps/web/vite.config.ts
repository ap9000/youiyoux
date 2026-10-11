import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    // Two documents: the hub, and the isolated preview frame that renders a system's real components.
    rolldownOptions: { input: { main: resolve(root, "index.html"), preview: resolve(root, "preview.html") } },
  },
  worker: { format: "es" },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
