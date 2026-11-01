/** youiyoux/vite: the live bridge in the head, before the app's scripts, only while Vite serves in development, and only from a hub on this machine. */
import { describe, expect, test } from "vitest";
import { youiyoux } from "../src/vite.js";

describe("youiyoux/vite", () => {
  test("serving, the bridge goes first in the head from the hub named; a build never gets it", () => {
    const plugin = youiyoux({ hub: "http://localhost:5312/" });
    expect(plugin.apply).toBe("serve");
    expect(plugin.transformIndexHtml()).toEqual([{ tag: "script", attrs: { src: "http://localhost:5312/api/live/bridge.js" }, injectTo: "head-prepend" }]);
  });

  test("a hub that isn't on this machine is refused", () => {
    expect(() => youiyoux({ hub: "https://hub.example.com" })).toThrow(/hub on this machine/);
    expect(() => youiyoux({ hub: "http://localhost.example.com:5173" })).toThrow(/hub on this machine/);
    expect(youiyoux({ hub: "http://127.0.0.1:5173" }).transformIndexHtml()[0]!.attrs.src).toBe("http://127.0.0.1:5173/api/live/bridge.js");
  });
});
