/**
 * Try it's server side: try.json (written beside the snapshot's public/, never in it) and the
 * endpoint that bundles one look by id, with the scanner's fence.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { tryIndexDeny, tryMiddleware, type TryIndex } from "../scripts/try-server.ts";

const SNAPSHOT = resolve(import.meta.dirname, "../snapshot");
const index = JSON.parse(readFileSync(join(SNAPSHOT, "try.json"), "utf8")) as TryIndex;
const scratch = mkdtempSync(join(tmpdir(), "youi-try-server-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** One request through the middleware: its status, headers and body, or "next" when it was not ours. */
async function call(middleware: ReturnType<typeof tryMiddleware>, url: string, method = "GET"): Promise<{ status: number; type: string; cache: string; body: string } | "next"> {
  let headers: Record<string, string> = {};
  return new Promise((done) => {
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string) => (headers = { ...headers, [name.toLowerCase()]: value }),
      end: (body: string) => done({ status: res.statusCode, type: headers["content-type"] ?? "", cache: headers["cache-control"] ?? "", body }),
    };
    void middleware({ url, method } as IncomingMessage, res as unknown as ServerResponse, () => done("next"));
  });
}

const tabsTrigger = (): string => Object.entries(index.projects.console!.specimens).find(([, s]) => s.look.recipe.export === "TabsTrigger")![0];

describe("try.json (c2)", () => {
  test("lives beside public/, never in it, and names project roots relative to the snapshot", () => {
    expect(existsSync(join(SNAPSHOT, "try.json"))).toBe(true);
    expect(existsSync(join(SNAPSHOT, "public/try.json"))).toBe(false);
    expect(index.schema).toBe("youiyoux.try/v1");
    expect(index.projects.console!.root).toBe("../../../packages/scanner/test/fixtures/inventory/console");
    expect(index.projects.console!.tsconfig).toBe("tsconfig.json");
    // The site's looks are all drawn from their classes: nothing to try.
    expect(Object.keys(index.projects.site?.specimens ?? {})).toEqual([]);
  });

  test("a tab trigger is listed with its siblings, in line order, so it has another tab to switch to", () => {
    const entry = index.projects.console!.specimens[tabsTrigger()]!;
    expect(entry.siblings.map((s) => s.label)).toEqual(["Runs", "Logs"]);
    expect(entry.siblings.every((s) => JSON.stringify(s.recipe.wrappers) === JSON.stringify(entry.look.recipe.wrappers))).toBe(true);
    // A button with no wrappers stands alone.
    const button = Object.values(index.projects.console!.specimens).find((s) => s.look.recipe.export === "Button")!;
    expect(button.siblings).toEqual([]);
  });
});

describe("try.json is not served to the browser (c2)", () => {
  test("the hub's dev server refuses it on every route, to its own page and to another localhost port; the endpoint still reads it", async () => {
    const { createServer } = await import("vite");
    const server = await createServer({ configFile: resolve(import.meta.dirname, "../vite.config.ts"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" }, optimizeDeps: { noDiscovery: true, include: [] } });
    try {
      await server.listen();
      const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
      const absolute = join(SNAPSHOT, "try.json");
      const routes = ["/snapshot/try.json", "/snapshot/try.json?import", "/snapshot/try.json?raw", "/snapshot/TRY.JSON", "/snapshot/%74ry.json", "/snapshot/./try.json", "/public/../snapshot/try.json", `/@fs${absolute}`, `/@fs${absolute}?import`, "/@snapshot/try.json"];
      for (const route of routes) {
        for (const from of [null, "http://localhost:5199"]) {
          const response = await fetch(`${origin}${route}`, { headers: from ? { Origin: from } : {} });
          const body = await response.text();
          // A 200 is only ever the SPA fallback: the hub's page, not the file.
          if (response.status === 200) expect(response.headers.get("content-type"), route).toContain("text/html");
          expect(body, route).not.toContain("youiyoux.try/v1");
        }
      }
      // Its siblings still load (the snapshot's data, Vite's own files), and Try it answers from it.
      expect((await fetch(`${origin}/data/manifest.json`)).status).toBe(200);
      expect((await fetch(`${origin}/@vite/client`)).status).toBe(200);
      const answer = await fetch(`${origin}/__youi/try?project=console&specimen=nope`);
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: "This look cannot be tried here: the hub has no record of it." });
    } finally {
      await server.close();
    }
  }, 60_000);

  test("the deny list keeps Vite's defaults and escapes glob characters in the snapshot path", () => {
    const deny = tryIndexDeny("/work/my (design)/[hub]");
    expect(deny).toEqual(expect.arrayContaining([".env", ".env.*", "**/.git/**"]));
    expect(deny.at(-1)).toBe("/work/my \\(design\\)/\\[hub\\]/try.json");
  });
});

describe("the Try it endpoint (c2)", () => {
  test("bundles a look by its ids, serves the script under its content hash, immutable; other URLs pass through", async () => {
    const middleware = tryMiddleware(SNAPSHOT);
    expect(await call(middleware, "/inventory")).toBe("next");
    expect(await call(middleware, "/__youi/try?project=console", "POST")).toBe("next");
    const answer = await call(middleware, `/__youi/try?project=console&specimen=${tabsTrigger()}`);
    if (answer === "next") throw new Error("not handled");
    expect(answer.status).toBe(200);
    expect(answer.cache).toBe("no-store");
    const { script } = JSON.parse(answer.body) as { script: string };
    expect(script).toMatch(/^\/__youi\/try\/[0-9a-f]{16}\.js$/);
    const code = await call(middleware, script);
    if (code === "next") throw new Error("not handled");
    expect(code.status).toBe(200);
    expect(code.type).toBe("text/javascript; charset=utf-8");
    expect(code.cache).toBe("public, max-age=31536000, immutable");
    expect(code.body).toContain("youi");
    expect(code.body.length).toBeGreaterThan(10_000);
  }, 60_000);

  test("ids only: an unknown project or specimen, or a path, is a 404 with a sentence; nothing is bundled", async () => {
    const load = vi.fn();
    const middleware = tryMiddleware(SNAPSHOT, "/", load);
    for (const query of ["project=nope&specimen=x", `project=console&specimen=nope`, "project=../../etc&specimen=passwd", "project=console&specimen=__proto__", "project=__proto__&specimen=x"]) {
      const answer = await call(middleware, `/__youi/try?${query}`);
      if (answer === "next") throw new Error("not handled");
      expect(answer.status).toBe(404);
      expect(JSON.parse(answer.body)).toEqual({ error: "This look cannot be tried here: the hub has no record of it." });
    }
    const unknown = await call(middleware, "/__youi/try/0000000000000000.js");
    expect(unknown !== "next" && unknown.status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });

  test("a recipe that leads outside its root answers 422 with the scanner's refusal; one build at a time per look", async () => {
    const snapshot = join(scratch, "snapshot");
    const console_ = index.projects.console!;
    const id = tabsTrigger();
    const look = console_.specimens[id]!.look;
    const outside: TryIndex = { schema: "youiyoux.try/v1", projects: { console: { ...console_, root: resolve(SNAPSHOT, console_.root), specimens: { [id]: { look: { ...look, recipe: { ...look.recipe, file: "../site/src/pages/index.astro" } }, siblings: [] } } } } };
    rmSync(snapshot, { recursive: true, force: true });
    (await import("node:fs")).mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "try.json"), JSON.stringify(outside));
    const scanner = await import("../../../packages/scanner/src/specimens/client.ts");
    const bundle = vi.fn(scanner.bundleForBrowser);
    const middleware = tryMiddleware(snapshot, "/", async () => ({ ...scanner, bundleForBrowser: bundle }) as never);
    const [first, second] = await Promise.all([call(middleware, `/__youi/try?project=console&specimen=${id}`), call(middleware, `/__youi/try?project=console&specimen=${id}`)]);
    for (const answer of [first, second]) {
      if (answer === "next") throw new Error("not handled");
      expect(answer.status).toBe(422);
      expect(JSON.parse(answer.body)).toEqual({ error: "refused: ../site/src/pages/index.astro is outside the project root" });
    }
    expect(bundle).toHaveBeenCalledTimes(1);
  });

  test("builds are capped: past the build slots and queue a look is answered 503 busy and never built (c3)", async () => {
    const scanner = await import("../../../packages/scanner/src/specimens/client.ts");
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => (release = done));
    const bundle = vi.fn(async () => {
      await gate;
      return { hash: "0123456789abcdef", code: "/* youi */", inputs: [] };
    });
    class OneAtATime extends scanner.BrowserBundleCache {
      constructor() {
        super({ builds: 1, queued: 1 });
      }
    }
    const middleware = tryMiddleware(SNAPSHOT, "/", async () => ({ ...scanner, BrowserBundleCache: OneAtATime, bundleForBrowser: bundle }) as never);
    const ids = Object.keys(index.projects.console!.specimens).slice(0, 3);
    expect(ids).toHaveLength(3);
    const first = call(middleware, `/__youi/try?project=console&specimen=${ids[0]}`);
    const second = call(middleware, `/__youi/try?project=console&specimen=${ids[1]}`);
    await vi.waitFor(() => expect(bundle).toHaveBeenCalledTimes(1));
    const third = await call(middleware, `/__youi/try?project=console&specimen=${ids[2]}`);
    if (third === "next") throw new Error("not handled");
    expect(third.status).toBe(503);
    expect(JSON.parse(third.body)).toEqual({ error: scanner.BUNDLE_BUSY });
    release();
    for (const answer of await Promise.all([first, second])) expect(answer !== "next" && answer.status).toBe(200);
    expect(bundle).toHaveBeenCalledTimes(2);
  });
});
