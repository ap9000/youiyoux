/**
 * The service's run (runBehaviour: the hub, MCP and `youiyoux behave`) hands the probe the
 * product's sources, so a button rendered by a component the code uses in more than one place
 * points at where this one is used. A stand-in probe (no browser) reports frames that the
 * consented loopback origin maps to the product's file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { runBehaviour, type BehaviourSetup } from "../src/index.ts";
import { behaviourSandbox, NO_BROWSER, TOOL } from "./behaviour-sandbox.ts";

const s = behaviourSandbox();
let server: Server;
let origin = "";

// The module the page runs: its lines 1, 2 and 3 map to NavRail.tsx 16 (RailButton's <button>), 11 and 12 (its uses).
const MAP = { version: 3, sources: ["/components/shell/NavRail.tsx"], mappings: "AAeA;AALA;AACA" };
const MODULE = `x\ny\nz\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(MAP)).toString("base64")}`;
const comments = Array.from({ length: 9 }, (_, i) => `// line ${i + 1}`).join("\n");
const SOURCE = `${comments}\nexport function NavRail() { return (<nav>\n<RailButton label="Search" />\n<RailButton label="Shortcuts" />\n</nav>); }\nfunction RailButton({ label }: { label: string }) {\n  return (\n<button aria-label={label} />\n  );\n}\n`;

beforeAll(async () => {
  server = createServer((req, res) => (req.url === "/src/NavRail.js" ? res.writeHead(200, { "content-type": "text/javascript" }).end(MODULE) : res.writeHead(404).end()));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server?.close();
});

type Probe = NonNullable<BehaviourSetup["probe"]>;
/** Two rail buttons, each the <button> of RailButton (frame line 1), used at frame lines 2 and 3. */
const railProbe = (async (options: Parameters<Probe>[0]) => {
  const popups = [
    { pattern: "modal-dialog" as const, component: "RailButton", accessibleName: "Search", use: 2 },
    { pattern: "modal-dialog" as const, component: "RailButton", accessibleName: "Shortcuts", use: 3 },
  ];
  options.onFound?.(popups.length);
  return {
    url: `${options.origin}${options.path}`,
    state: "probed" as const,
    why: null,
    fix: null,
    coverage: "2 popup triggers found by ARIA markers.",
    targets: popups.map(({ use, ...p }, i) => ({
      key: { route: options.route, ...p },
      found: { ...p, via: "dom" as const, frames: [1, use].map((line) => ({ url: `${options.origin}/src/NavRail.js`, line, column: 1 })), domPath: "button", box: { x: 10 * i, y: 0, width: 10, height: 10 } },
      scenarios: options.checks.map((check) => ({ check, state: "passed" as const, popup: { state: "open" as const, how: "aria-controls" as const, role: "dialog", domPath: "div" }, why: "Esc closed the dialog", fix: "Next: none.", info: [], index: 0, keys: ["Escape"] })),
    })),
  };
}) as unknown as Probe;

describe("the service's behaviour run", () => {
  test("hands the probe the product's sources: each rail button points at its own use, RailButton's line as rendered by", async () => {
    mkdirSync(join(s.box.project, "components/shell"), { recursive: true });
    writeFileSync(join(s.box.project, "components/shell/NavRail.tsx"), SOURCE);
    s.screens({ allowedOrigin: origin, generation: 1 }, origin);
    const project = await loadProject(s.box.project, { designRoot: s.box.design });
    const { run } = await (await runBehaviour(project, { tool: TOOL, browser: NO_BROWSER, probe: railProbe }, { route: "/x", by: "agent" })).done;
    expect(run.results.map((r) => [r.target.accessibleName, r.target.file, r.target.line, r.target.renderedBy])).toEqual([
      ["Search", "components/shell/NavRail.tsx", 11, { file: "components/shell/NavRail.tsx", line: 16 }],
      ["Shortcuts", "components/shell/NavRail.tsx", 12, { file: "components/shell/NavRail.tsx", line: 16 }],
    ]);
  });
});
