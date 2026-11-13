/**
 * Runs of one route never replace newer evidence with older (review round 1, finding 2): a route's
 * run is claimed across processes (another youiyoux process holding it refuses this one), and a
 * run that started earlier but finishes later is discarded rather than published over a later one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { behaviourFile, probeBehaviour, WorkflowError } from "../src/index.ts";
import { behaviourSandbox, control, NO_BROWSER, RULE_ID, standIn, tick, TOOL } from "./behaviour-sandbox.ts";

const s = behaviourSandbox();
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill();
});

describe("another process", () => {
  test("holding a route's run refuses this one for that route (naming it), not for another route; it publishes when it ends", async () => {
    const release = join(s.box.dir, "release");
    const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/hold-behaviour-run.ts"), s.box.project, s.box.design, "/x", release], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    let err = "";
    child.stdout!.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr!.on("data", (c: Buffer) => (err += c.toString("utf8")));
    const exited = new Promise<number | null>((done) => child.on("exit", done));
    for (let i = 0; i < 600 && !out.includes("probing"); i++) await new Promise((done) => setTimeout(done, 50));
    expect(out, err).toContain("probing");
    control.probes = 0;
    const refused = await s.write("/api/behaviour/run", { route: "/x" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(new RegExp(`^a behaviour run is already going for this app \\(/x, in another youiyoux: pid ${child.pid}, still running\\)`));
    expect(control.probes).toBe(0);
    // Another route isn't held.
    await s.runFromHub("/y");
    writeFileSync(release, "");
    expect(await exited, err).toBe(0);
    const { runId } = JSON.parse(out.split("\n").find((l) => l.startsWith("{"))!) as { runId: string };
    expect((JSON.parse(readFileSync(join(s.box.project, behaviourFile("/x")), "utf8")) as { runId: string }).runId).toBe(runId);
    // Its claim is let go: this process may run the route now.
    await s.runFromHub("/x");
  }, 60_000);
});

describe("an unreadable claim", () => {
  test("a folder where the route's claim goes refuses a run at once, naming it; it doesn't spin", async () => {
    const lock = `${join(s.box.project, behaviourFile("/x"))}.lock`;
    mkdirSync(join(s.box.project, ".youi/behaviour"), { recursive: true });
    mkdirSync(lock);
    try {
      control.probes = 0;
      const started = Date.now();
      const refused = await s.write("/api/behaviour/run", { route: "/x" });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(refused.status).toBe(409);
      expect(refused.json.error).toMatch(/^a behaviour run is already going for this app \(\/x, in another youiyoux: a lock youiyoux can't read \(EISDIR\)\)/);
      expect(control.probes).toBe(0);
    } finally {
      rmSync(lock, { recursive: true });
    }
  }, 15_000);
});

describe("an earlier-started run that finishes later", () => {
  test("is discarded, never published over the later run", async () => {
    const clock = (...times: string[]) => {
      const left = [...times];
      return () => new Date(left.shift() ?? times.at(-1)!);
    };
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const deciding = (verdict: "passed" | "failed", wait: Promise<void> | null) =>
      (async (options: Parameters<typeof standIn>[0]) => {
        if (wait) await wait;
        control.verdict = verdict;
        return standIn(options);
      }) as typeof standIn;
    const checks = [{ rule: RULE_ID, check: "dismiss-escape" as const, digest: "0123456789ab" }];
    const fingerprint = { app: "abcdef012345", tool: TOOL };
    // A passing run starts first and is held; a failing one starts later and finishes first.
    const earlier = probeBehaviour({ root: s.box.project, route: "/x", browser: await NO_BROWSER(), checks, fingerprint, probe: deciding("passed", gate), now: clock("2030-01-01T00:00:00.000Z", "2030-01-01T00:00:03.000Z") });
    await tick();
    const later = await probeBehaviour({ root: s.box.project, route: "/x", browser: await NO_BROWSER(), checks, fingerprint, probe: deciding("failed", null), now: clock("2030-01-01T00:00:01.000Z", "2030-01-01T00:00:02.000Z") });
    expect(later.run.results.some((r) => r.state === "failed")).toBe(true);
    release();
    const discarded = await earlier.then(() => null, (e: unknown) => e);
    expect(discarded).toBeInstanceOf(WorkflowError);
    expect((discarded as WorkflowError).message).toBe("a newer run of /x (started 2030-01-01T00:00:01.000Z) is already kept, so this one (started 2030-01-01T00:00:00.000Z) was discarded; nothing was written");
    const kept = JSON.parse(readFileSync(join(s.box.project, behaviourFile("/x")), "utf8")) as { runId: string; startedAt: string };
    expect(kept).toMatchObject({ runId: later.run.runId, startedAt: "2030-01-01T00:00:01.000Z" });
  });
});
