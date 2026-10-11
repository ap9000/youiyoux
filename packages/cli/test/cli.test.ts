import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "../../scanner/test/fixtures/expo-app");
const REPO = join(import.meta.dirname, "../../..");

let out = "";
let err = "";
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("youi", () => {
  test("help and unknown commands", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toContain("youi <command>");
    expect(await main(["frobnicate"])).toBe(2);
    expect(err).toContain("unknown command");
    expect(await main(["where"])).toBe(2);
    expect(err).toContain("usage: youi where <component>");
  });

  test("where --json answers from a fresh scan", async () => {
    expect(await main(["where", "button", "--project", FIXTURE, "--json"])).toBe(0);
    const where = JSON.parse(out) as { total: number; byRoute: Array<{ route: string }>; coverage: { status: string } };
    expect(where.total).toBe(7);
    expect(where.byRoute.map((r) => r.route)).toEqual(expect.arrayContaining(["/", "/settings", "/checkout"]));
    expect(where.coverage.status).toBe("partial");
  });

  test("check exits 1 when there are errors, and show prints the contract", async () => {
    expect(await main(["check", "--project", FIXTURE, "--json"])).toBe(1);
    expect((JSON.parse(out) as { errors: number }).errors).toBeGreaterThan(0);
    out = "";
    expect(await main(["show", "badge", "--project", FIXTURE, "--json"])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ name: "Badge", import: "import { Badge } from \"@/components/ui\";" });
  });

  test("a bad component name is an error with the known names", async () => {
    expect(await main(["show", "carousel", "--project", FIXTURE])).toBe(1);
    expect(err).toContain("known: Badge, Button");
  });

  test("init writes a project config from what it finds, then syncs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "youi-init-"));
    try {
      await cp(join(FIXTURE, "app"), join(dir, "app"), { recursive: true });
      await cp(join(FIXTURE, "tsconfig.json"), join(dir, "tsconfig.json"));
      await (await import("node:fs/promises")).writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/mobile", dependencies: { "expo-router": "6.0.0" } }));
      expect(await main(["init", "--project", dir, "--source", REPO])).toBe(0);
      const config = JSON.parse(await readFile(join(dir, "youi.project.json"), "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({ id: "mobile", componentsDir: "components/ui", importFrom: "@/components/ui", routes: { strategy: "expo-router", appDir: "app" } });
      expect(await readFile(join(dir, "components/ui/button.tsx"), "utf8")).toContain("buttonVariants");
      expect(await main(["init", "--project", dir, "--source", REPO])).toBe(1);
      expect(err).toContain("already exists");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
