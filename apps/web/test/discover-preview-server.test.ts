/**
 * Discover previews' server side (c1, c2): nothing is fetched until a candidate is opened; an
 * opened one is fetched from recorded responses (no network), bundled in the console fixture's
 * setting and drawn with its CSS, Tailwind's sources widened to the fetched files, and theme fit
 * says what could not be themed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { syncIndex } from "../../../packages/discover/src/index.ts";
import { fixtureFetcher } from "../../../packages/discover/test/fixture-fetcher.ts";
import type { Fetcher } from "../../../packages/discover/src/index.ts";
import { discoverPreviewMiddleware, projectParts, uiDirOf, type PreviewAnswer } from "../scripts/discover-preview-server.ts";

const SNAPSHOT = resolve(import.meta.dirname, "../snapshot");
const ITEM = (name: string) => `https://ui.shadcn.com/r/styles/new-york-v4/${name}.json`;
let cache: string;

beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "youi-discover-preview-"));
  await syncIndex({ sleep: async () => {}, cacheDir: cache, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
}, 60_000);
afterAll(() => rmSync(cache, { recursive: true, force: true }));

async function call(middleware: ReturnType<typeof discoverPreviewMiddleware>, url: string, host = "localhost:5173", extra: Record<string, string> = {}): Promise<{ status: number; type: string; body: string } | "next"> {
  let headers: Record<string, string> = {};
  return new Promise((done) => {
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string) => (headers = { ...headers, [name.toLowerCase()]: value }),
      end: (body: string) => done({ status: res.statusCode, type: headers["content-type"] ?? "", body }),
    };
    void middleware({ url, method: "GET", headers: { host, ...extra } } as unknown as IncomingMessage, res as unknown as ServerResponse, () => done("next"));
  });
}

const json = (answer: Awaited<ReturnType<typeof call>>) => {
  if (answer === "next") throw new Error("not answered");
  return { status: answer.status, body: JSON.parse(answer.body) as PreviewAnswer & { error: string | null } };
};

describe("Discover previews (c1, c2)", () => {
  test("a synced catalog holds listings only: no source and no preview files until a candidate is opened", () => {
    expect(existsSync(join(cache, "source"))).toBe(false);
    expect(existsSync(join(cache, "preview"))).toBe(false);
  });

  test("opening shadcn's command fetches it and the part it needs, bundles it in the console's setting and says what could not be themed", async () => {
    const fixtures = fixtureFetcher();
    const middleware = discoverPreviewMiddleware(SNAPSHOT, "/", { cache, fetcher: fixtures.fetcher });
    const { status, body } = json(await call(middleware, "/__youi/discover-preview?id=%40shadcn%2Fcommand&project=console"));
    expect(body.error).toBeNull();
    expect(status).toBe(200);
    // Only the opened item, and the dialog it imports (the console's dialog lacks DialogHeader and others); its button is the console's own.
    expect(fixtures.requests.map((r) => r.url)).toEqual([ITEM("command"), ITEM("dialog")]);
    expect(body.fetched).toBe(true);
    // A component, not a block: drawn as one, not as a page.
    expect(body.page).toBe(false);
    expect(body.parts.map((p) => [p.name, p.from])).toEqual([["dialog", "fetched"], ["button", "project"]]);
    expect(body.license).toBe("MIT");
    expect(body.install?.command).toBe("npx shadcn add command");
    expect(body.compose?.export).toBe("Command");
    expect(body.notes).toEqual(expect.arrayContaining(["cn: your src/lib/utils.ts", "cmdk, lucide-react, radix-ui: not installed in your project, so the hub's own copies draw them"]));
    expect(body.implicitDeps).toEqual(expect.arrayContaining(["lucide-react"]));
    expect(body.fit.themed).toContain("rounded-md draws with your --radius-md: 8px (Tailwind's default is 6px)");
    expect(body.fit.unthemed.some((line) => /bg-popover.*your theme has no .*--color-popover/.test(line))).toBe(true);
    // The script and both sheets are served by their hash; the sheet is the console's, built over the fetched files too.
    const script = await call(middleware, body.script!);
    expect(script !== "next" && script.status === 200 && script.type.startsWith("text/javascript")).toBe(true);
    for (const scheme of ["light", "dark"] as const) {
      const sheet = await call(middleware, body.css![scheme]);
      if (sheet === "next") throw new Error("not answered");
      expect(sheet.type).toMatch(/^text\/css/);
      expect(sheet.body).toContain("Console Mono");
      expect(sheet.body).toContain("cmdk-group-heading");
      expect(sheet.body).toContain(`color-scheme: ${scheme}`);
      expect(sheet.body).toContain("youi-state-hover");
    }
    expect(readdirSync(join(cache, "preview")).length).toBe(1);
    // Opened again: from the cache, nothing fetched.
    const again = fixtureFetcher();
    const second = json(await call(discoverPreviewMiddleware(SNAPSHOT, "/", { cache, fetcher: again.fetcher }), "/__youi/discover-preview?id=lib%3Ashadcn%2Fcomponent%2Fcommand&project=console"));
    expect(again.requests).toEqual([]);
    expect(second.body.fetched).toBe(false);
  }, 60_000);

  test("one build per candidate at a time: two opens at once share it", async () => {
    const fixtures = fixtureFetcher({ delayMs: 20 });
    const fresh = mkdtempSync(join(tmpdir(), "youi-discover-preview-once-"));
    try {
      await syncIndex({ sleep: async () => {}, cacheDir: fresh, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
      const middleware = discoverPreviewMiddleware(SNAPSHOT, "/", { cache: fresh, fetcher: fixtures.fetcher });
      const [a, b] = await Promise.all([call(middleware, "/__youi/discover-preview?id=%40shadcn%2Finput&project=console"), call(middleware, "/__youi/discover-preview?id=%40shadcn%2Finput&project=console")]);
      expect(json(a).body.script).toBe(json(b).body.script);
      expect(fixtures.requests.map((r) => r.url)).toEqual([ITEM("input")]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }, 60_000);

  test("an npm package is listed without a drawing, in a sentence", async () => {
    const { status, body } = json(await call(discoverPreviewMiddleware(SNAPSHOT, "/", { cache, fetcher: fixtureFetcher().fetcher }), "/__youi/discover-preview?id=lib%3Anpm%2Fcomponent%2Fsonner&project=console"));
    expect(status).toBe(200);
    expect(body.script).toBeNull();
    expect(body.error).toMatch(/npm package, not a registry item/);
  });

  test("a preview that runs past its limit is stopped with a sentence", async () => {
    const slow = fixtureFetcher({ override: (url) => (url === ITEM("button") ? { behavior: "timeout" } : undefined) });
    const { status, body } = json(await call(discoverPreviewMiddleware(SNAPSHOT, "/", { cache, fetcher: slow.fetcher, timeoutMs: 300 }), "/__youi/discover-preview?id=%40shadcn%2Fbutton&project=console"));
    expect(status).toBe(504);
    expect(body.error).toMatch(/took over .* and was stopped/);
  });

  test("this machine only, ids only, and projects the hub knows", async () => {
    const middleware = discoverPreviewMiddleware(SNAPSHOT, "/", { cache, fetcher: fixtureFetcher().fetcher });
    expect(json(await call(middleware, "/__youi/discover-preview?id=%40shadcn%2Fcommand", "evil.example:5173")).status).toBe(403);
    for (const id of ["../../etc/passwd", "/etc/passwd", "lib:x/component/../../y"]) expect(json(await call(middleware, `/__youi/discover-preview?id=${encodeURIComponent(id)}`)).status, id).toBe(400);
    expect(json(await call(middleware, "/__youi/discover-preview?id=%40shadcn%2Fcommand&project=nope")).status).toBe(404);
    expect(json(await call(middleware, "/__youi/discover-preview/0123456789abcdef.js")).status).toBe(404);
    expect(await call(middleware, "/__youi/query?kind=discover")).toBe("next");
  });

  test("another site cannot ask for a build: a foreign or null Origin, or Sec-Fetch-Site cross-site, is refused; the hub's own page is not", async () => {
    const fixtures = fixtureFetcher();
    const middleware = discoverPreviewMiddleware(SNAPSHOT, "/", { cache, fetcher: fixtures.fetcher });
    const ask = "/__youi/discover-preview?id=%40shadcn%2Fcommand&project=console";
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "http://localhost.evil.example:5173" }, { "sec-fetch-site": "cross-site" }] as Array<Record<string, string>>) {
      const { status, body } = json(await call(middleware, ask, "localhost:5173", headers));
      expect(status, JSON.stringify(headers)).toBe(403);
      expect(body.error).toMatch(/another site is refused/);
    }
    expect(fixtures.requests).toEqual([]);
    expect(json(await call(middleware, ask, "localhost:5173", { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" })).status).toBe(200);
    // On a name given to youiyoux ui --allow-host, the hub's page there is its own; other sites still are not.
    vi.stubEnv("YOUI_ALLOW_HOSTS", "my-mac.example.ts.net");
    try {
      expect(json(await call(middleware, ask, "my-mac.example.ts.net:8446", { origin: "https://my-mac.example.ts.net:8446", "sec-fetch-site": "same-origin" })).status).toBe(200);
      expect(json(await call(middleware, ask, "my-mac.example.ts.net:8446", { origin: "https://evil.example" })).status).toBe(403);
      expect(json(await call(middleware, ask, "evil.example:8446")).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  describe("builds are bounded", () => {
    /** A network that holds every request until released, and says which were aborted. */
    function heldNetwork() {
      const held: Array<{ url: string; signal: AbortSignal; release: () => void }> = [];
      const fixtures = fixtureFetcher();
      let open = false;
      const fetcher: Fetcher = (url, init) =>
        open ? fixtures.fetcher(url, init) : new Promise((resolve, reject) => {
          const entry = { url, signal: init.signal, release: () => resolve(fixtures.fetcher(url, init)) };
          held.push(entry);
          init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
        });
      /** Let everything held, and everything after, through. */
      const release = (): void => {
        open = true;
        for (const entry of held) entry.release();
      };
      return { held, fetcher, release };
    }
    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(check()).toBe(true);
    };
    let fresh: string;
    beforeAll(async () => {
      fresh = mkdtempSync(join(tmpdir(), "youi-discover-preview-cap-"));
      await syncIndex({ sleep: async () => {}, cacheDir: fresh, fetcher: fixtureFetcher().fetcher, now: () => new Date("2026-10-12T12:00:00Z"), timeoutMs: 100 });
    }, 60_000);
    afterAll(() => rmSync(fresh, { recursive: true, force: true }));

    test("two build at once, four wait, and the next is answered 503", async () => {
      const network = heldNetwork();
      const middleware = discoverPreviewMiddleware(SNAPSHOT, "/", { cache: fresh, fetcher: network.fetcher, maxBuilds: 2, maxQueued: 4 });
      const refs = ["@shadcn/calendar", "@shadcn/popover", "@shadcn/sonner", "@shadcn/input-group", "@coss/toast", "@coss/autocomplete"];
      const answers = refs.map((ref) => call(middleware, `/__youi/discover-preview?id=${encodeURIComponent(ref)}&project=console`));
      // Only two reach the network; four wait for a slot.
      await until(() => network.held.length === 2);
      await new Promise((r) => setTimeout(r, 100));
      expect(network.held).toHaveLength(2);
      const full = json(await call(middleware, "/__youi/discover-preview?id=%40shadcn%2Fdialog&project=console"));
      expect(full.status).toBe(503);
      expect(full.body.error).toMatch(/already drawing 2 previews with 4 waiting/);
      // Released, every waiting build gets its turn.
      network.release();
      for (const answer of await Promise.all(answers)) expect(answer !== "next" && answer.status).toBe(200);
    }, 60_000);

    test("a build past its limit is aborted, not just abandoned: its request is cancelled and its slot frees", async () => {
      const network = heldNetwork();
      const middleware = discoverPreviewMiddleware(SNAPSHOT, "/", { cache: fresh, fetcher: network.fetcher, timeoutMs: 1500, maxBuilds: 1, maxQueued: 0 });
      // Warm: the modules load once (an npm listing needs no network).
      expect(json(await call(middleware, "/__youi/discover-preview?id=lib%3Anpm%2Fcomponent%2Fsonner&project=console")).status).toBe(200);
      const { status, body } = json(await call(middleware, "/__youi/discover-preview?id=%40coss%2Fdialog&project=console"));
      expect(status).toBe(504);
      expect(body.error).toMatch(/took over .* and was stopped/);
      expect(network.held).toHaveLength(1);
      expect(network.held[0]!.signal.aborted).toBe(true);
      // The one slot is free again: the next build starts (and reaches the network).
      const next = call(middleware, "/__youi/discover-preview?id=%40coss%2Fbutton&project=console");
      await until(() => network.held.length === 2);
      network.release();
      expect(json(await next).status).toBe(200);
    }, 60_000);
  });
});

describe("the project's own component a preview borrows", () => {
  test("never one inside a nested package; the folder components.json names first", () => {
    const root = mkdtempSync(join(tmpdir(), "youi-project-parts-"));
    try {
      const write = (file: string, text: string): void => {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), text);
      };
      write("package.json", "{}");
      // A design package of its own, nested in the repository and not installed (as Toolroll's design/).
      write("design/package.json", "{}");
      write("design/src/components/ui/button.tsx", 'import { Slot } from "radix-ui";\nexport function Button() { return null; }\n');
      write("src/legacy/components/button.tsx", "export function Button() { return null; }\n");
      write("src/components/ui/button.tsx", "export function Button() { return null; }\nexport const buttonVariants = 1;\n");
      write("components.json", JSON.stringify({ aliases: { ui: "@/components/ui" } }));
      // In path order, the nested package's comes first.
      const files = ["design/src/components/ui/button.tsx", "src/legacy/components/button.tsx", "src/components/ui/button.tsx"];
      const names = (source: string): string[] => [...source.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]!);
      const uiDir = uiDirOf(root, [["@/", "src/"]]);
      expect(uiDir).toBe("src/components/ui");
      expect(projectParts(root, files, names, uiDir)("button")).toMatchObject({ display: "src/components/ui/button.tsx", exports: ["Button", "buttonVariants"] });
      // Without components.json: the first of the project's own, still never the nested package's.
      expect(projectParts(root, files, names)("button")?.display).toBe("src/legacy/components/button.tsx");
      expect(projectParts(root, ["design/src/components/ui/button.tsx"], names)("button")).toBeNull();
      expect(uiDirOf(root, [])).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
