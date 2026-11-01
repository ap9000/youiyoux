/**
 * youiyoux's Vite plugin: while the app runs in development, the live bridge goes in the page's
 * head, before the app's scripts, so the hub (youiyoux ui --project) can show the running app on its
 * Screens canvas, comment on it and edit its components in place. Nothing in a build.
 *
 * The bridge does nothing unless the hub frames the page on this machine.
 *
 *   import { youiyoux } from "youiyoux/vite";
 *   export default defineConfig({ plugins: [youiyoux({ hub: "http://localhost:5312" })] });
 */

/** Where the hub runs: `hub`, else YOUIYOUX_HUB, else youiyoux ui's default port. */
export function youiyoux(options = {}) {
  const hub = String(options.hub ?? process.env.YOUIYOUX_HUB ?? "http://localhost:5173").replace(/\/+$/, "");
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(hub)) throw new Error(`youiyoux/vite: hub must be the hub on this machine (http://localhost:<port>), not ${hub}`);
  return {
    name: "youiyoux",
    apply: "serve",
    transformIndexHtml: () => [{ tag: "script", attrs: { src: `${hub}/api/live/bridge.js` }, injectTo: "head-prepend" }],
  };
}

export default youiyoux;
