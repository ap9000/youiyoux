/**
 * Runs of one route never replace newer evidence with older (review round 1, finding 2): a route's
 * run is claimed across processes (another youiyoux process holding it refuses this one), and a
 * run that started earlier but finishes later is discarded rather than published over a later one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import * as index from "../src/index.ts";
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

describe("publication only under the route's claim", () => {
  const clock = (...times: string[]) => {
    const left = [...times];
    return () => new Date(left.shift() ?? times.at(-1)!);
  };
  const deciding = (verdict: "passed" | "failed", wait: Promise<void> | null) =>
    (async (options: Parameters<typeof standIn>[0]) => {
      if (wait) await wait;
      control.verdict = verdict;
      return standIn(options);
    }) as typeof standIn;
  const checks = [{ rule: RULE_ID, check: "dismiss-escape" as const, digest: "0123456789ab" }];
  const fingerprint = { app: "abcdef012345", tool: TOOL };
  const direct = async (verdict: "passed" | "failed", wait: Promise<void> | null, now?: () => Date) =>
    probeBehaviour({ root: s.box.project, route: "/x", browser: await NO_BROWSER(), checks, fingerprint, probe: deciding(verdict, wait), ...(now ? { now } : {}) });
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => e as WorkflowError);

  test("the package's exports publish a run only under its route's claim: two at once, one is refused; the hub's run is refused meanwhile", async () => {
    // Nothing exported writes a run file without the claim.
    expect(Object.keys(index).filter((name) => /publish|unclaimed|underclaim|writechecked/i.test(name))).toEqual([]);
    const written = await refusal(index.writeYouiFile(s.box.project, behaviourFile("/x"), "{}"));
    expect(written?.message).toMatch(/is a behaviour run: it is written only by a run holding its route's claim/);
    // A claim-shaped object, on the right root and route and saying it holds, isn't a claim.
    const forged = await refusal(index.probeBehaviour({ root: s.box.project, route: "/x", browser: await NO_BROWSER(), checks, fingerprint, probe: standIn, claim: { root: realpathSync(s.box.project), route: "/x", startedAt: "2030-01-01T00:00:00.000Z", holds: async () => true, release: async () => undefined } }));
    expect(forged?.message).toBe("a behaviour run is published only under its own route's claim; nothing was probed");
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const first = direct("passed", gate);
    await tick();
    const second = await refusal(direct("failed", null));
    expect(second?.message).toMatch(/^a behaviour run is already going for this app \(\/x, in another youiyoux: pid \d+, still running\)/);
    expect((await s.write("/api/behaviour/run", { route: "/x" })).status).toBe(409);
    release();
    const { run } = await first;
    expect((JSON.parse(readFileSync(join(s.box.project, behaviourFile("/x")), "utf8")) as { runId: string }).runId).toBe(run.runId);
  });

  test("a run whose claim was lost meanwhile writes nothing", async () => {
    const before = readFileSync(join(s.box.project, behaviourFile("/x")), "utf8");
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const running = refusal(direct("passed", gate));
    await tick();
    // Its lock is gone (removed by hand, say) and another holder takes it.
    const lock = `${join(s.box.project, behaviourFile("/x"))}.lock`;
    rmSync(lock);
    const other = await index.claimRoute(s.box.project, "/x");
    release();
    expect((await running)?.message).toBe("the claim on /x was lost during the run, so nothing was written; run it again");
    await other.release();
    expect(readFileSync(join(s.box.project, behaviourFile("/x")), "utf8")).toBe(before);
  });

  test("a run that started earlier than the one kept is discarded, never published over it", async () => {
    const later = await direct("failed", null, clock("2030-01-01T00:00:01.000Z", "2030-01-01T00:00:02.000Z"));
    expect(later.run.startedAt).toBe("2030-01-01T00:00:01.000Z");
    const discarded = await refusal(direct("passed", null, clock("2030-01-01T00:00:00.000Z", "2030-01-01T00:00:03.000Z")));
    expect(discarded?.message).toBe("a newer run of /x (started 2030-01-01T00:00:01.000Z) is already kept, so this one (started 2030-01-01T00:00:00.000Z) was discarded; nothing was written");
    const kept = JSON.parse(readFileSync(join(s.box.project, behaviourFile("/x")), "utf8")) as { runId: string; startedAt: string };
    expect(kept).toMatchObject({ runId: later.run.runId, startedAt: "2030-01-01T00:00:01.000Z" });
  });
});
