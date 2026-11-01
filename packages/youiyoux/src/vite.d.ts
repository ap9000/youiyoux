/** youiyoux's Vite plugin: the live bridge in the page's head while the app runs in development. */
export interface YouiyouxViteOptions {
  /** Where `youiyoux ui --project` runs on this machine (http://localhost:<port>); else YOUIYOUX_HUB, else http://localhost:5173. */
  hub?: string;
}
export declare function youiyoux(options?: YouiyouxViteOptions): {
  name: "youiyoux";
  apply: "serve";
  transformIndexHtml: () => Array<{ tag: "script"; attrs: { src: string }; injectTo: "head-prepend" }>;
};
export default youiyoux;
