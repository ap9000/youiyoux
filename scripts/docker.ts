/**
 * `pnpm docker [--tag name] [--tarball file] [--smoke]`
 *
 * Builds the hosted hub's image (docker/Dockerfile) from the npm package's tarball: `pnpm pack` of
 * packages/youiyoux, or --tarball (the release workflow passes the one it published). The build
 * context holds that tarball alone. --smoke then runs the image as a team would, with secrets
 * made for this run only and passed through the environment (never argv): it waits for the
 * health check, sends a record with the ingest token, reads it back with the view key, checks the
 * hub runs as a user other than root, and removes the container. Then it runs it again with
 * workspaces (a made-up OAuth App: nobody signs in): the admin commands, run in the container,
 * add a workspace and a CI token, and a record sent with that token is filed under it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dirname, "..");
export const DOCKERFILE = join(root, "docker/Dockerfile");

/** A record as CI sends it: one repository, one product (youi.record/v1). */
export function smokeRecord(now: Date): Record<string, unknown> {
  return {
    schema: "youi.record/v1",
    repo: "acme/smoke",
    commit: "a".repeat(40),
    ref: "main",
    generatedAt: now.toISOString(),
    tool: "smoke",
    products: [
      {
        id: "web",
        root: ".",
        system: { id: "acme", name: "Acme", version: "1.0.0", source: "package @acme/design", linked: false, commit: null },
        lock: { systemVersion: "1.0.0", syncedAt: now.toISOString() },
        sync: { state: "current", changes: [] },
        drift: [],
        check: { errors: 0, warnings: 0, baseline: null, incomplete: false },
        components: { system: 1, used: 1, sites: 1 },
        requests: { open: 0, addressed: 0, unreadable: 0 },
        next: "nothing to do",
      },
    ],
  };
}

const docker = (args: readonly string[], env: NodeJS.ProcessEnv = process.env): string => execFileSync("docker", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] }).trim();

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ok = await fetch(`${url}/api/health`).then((r) => r.ok, () => false);
    if (ok) return;
    if (Date.now() > until) throw new Error(`the hub did not answer ${url}/api/health within ${timeoutMs / 1000}s`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

async function smoke(tag: string): Promise<void> {
  // Made for this run, handed to docker through its environment: `-e NAME` alone reads the value from there.
  const secrets = { YOUIYOUX_HUB_TOKEN: randomBytes(24).toString("base64url"), YOUIYOUX_HUB_VIEW_KEY: randomBytes(24).toString("base64url") };
  const id = docker(["run", "-d", "--rm", "-p", "127.0.0.1::8080", "-e", "YOUIYOUX_HUB_TOKEN", "-e", "YOUIYOUX_HUB_VIEW_KEY", tag], { ...process.env, ...secrets });
  try {
    const port = docker(["port", id, "8080/tcp"]).split("\n")[0]!.split(":").pop()!;
    const url = `http://127.0.0.1:${port}`;
    await waitHealthy(url, 60_000);
    const uid = docker(["exec", id, "id", "-u"]);
    if (uid === "0") throw new Error("the hub runs as root in the image");
    const sent = await fetch(`${url}/api/records`, { method: "POST", headers: { authorization: `Bearer ${secrets.YOUIYOUX_HUB_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(smokeRecord(new Date())) });
    if (sent.status !== 201) throw new Error(`sending a record answered ${sent.status}: ${await sent.text()}`);
    const refused = await fetch(`${url}/api/org`);
    if (refused.status !== 401) throw new Error(`the organisation answered ${refused.status} without the view key`);
    const org = await fetch(`${url}/api/org`, { headers: { authorization: `Bearer ${secrets.YOUIYOUX_HUB_VIEW_KEY}` } });
    const body = (await org.json()) as { repos?: Array<{ repo: string }> };
    if (!org.ok || !body.repos?.some((r) => r.repo === "acme/smoke")) throw new Error(`the organisation did not list the record (${org.status})`);
    const page = await fetch(url);
    if (!page.ok || !(await page.text()).includes('name="youi-org"')) throw new Error(`the hub's page did not load in its organisation mode (${page.status})`);
    console.log(`smoke: ${tag} healthy as uid ${uid}; a record sent and read back; the page loads`);
  } catch (error) {
    spawnSync("docker", ["logs", id], { stdio: "inherit" });
    throw error;
  } finally {
    spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  }
}

/** The hub with workspaces: its admin commands in the container, and a record routed by a workspace's CI token. */
async function smokeWorkspaces(tag: string): Promise<void> {
  // A made-up app: the hub needs one to start in this mode, and GitHub is never asked here.
  const app = { YOUIYOUX_HUB_GITHUB_CLIENT_ID: "smoke-client", YOUIYOUX_HUB_GITHUB_CLIENT_SECRET: randomBytes(24).toString("base64url"), YOUIYOUX_HUB_AUDIENCE: "http://localhost:8080" };
  const id = docker(["run", "-d", "--rm", "-p", "127.0.0.1::8080", ...Object.keys(app).flatMap((name) => ["-e", name]), tag], { ...process.env, ...app });
  try {
    const port = docker(["port", id, "8080/tcp"]).split("\n")[0]!.split(":").pop()!;
    const url = `http://127.0.0.1:${port}`;
    await waitHealthy(url, 60_000);
    docker(["exec", id, "youiyoux", "hub", "workspace", "add", "smoke", "--name", "Smoke"]);
    const token = /\b(yxh_[\w-]{43})\b/.exec(docker(["exec", id, "youiyoux", "hub", "token", "add", "smoke", "ci"]))?.[1];
    if (!token) throw new Error("youiyoux hub token add printed no token");
    const sent = await fetch(`${url}/api/records`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(smokeRecord(new Date())) });
    const body = (await sent.json()) as { workspace?: string };
    if (sent.status !== 201 || body.workspace !== "smoke") throw new Error(`a record with the workspace's token answered ${sent.status} ${JSON.stringify(body)}`);
    const me = await fetch(`${url}/api/me`);
    if (me.status !== 401) throw new Error(`/api/me answered ${me.status} with nobody signed in`);
    if (!(await (await fetch(url)).text()).includes('name="youi-org-mode" content="workspaces"')) throw new Error("the hub's page is not in its workspace mode");
    const listed = docker(["exec", id, "youiyoux", "hub", "workspace", "list", "--json"]);
    if (!(JSON.parse(listed) as Array<{ id: string; tokens: string[] }>).some((w) => w.id === "smoke" && w.tokens.includes("ci"))) throw new Error("youiyoux hub workspace list does not show the workspace and its token");
    console.log(`smoke: ${tag} with workspaces: a workspace and its CI token added in the container, a record filed under it`);
  } catch (error) {
    spawnSync("docker", ["logs", id], { stdio: "inherit" });
    throw error;
  } finally {
    spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { tag: { type: "string" }, tarball: { type: "string" }, smoke: { type: "boolean", default: false } } });
  const tag = values.tag ?? "youiyoux-hub:dev";
  const context = mkdtempSync(join(tmpdir(), "youiyoux-docker-"));
  try {
    let tarball = values.tarball;
    if (!tarball) {
      execFileSync("pnpm", ["pack", "--pack-destination", context], { cwd: join(root, "packages/youiyoux"), stdio: ["ignore", "ignore", "inherit"] });
      tarball = join(context, readdirSync(context).find((f) => f.endsWith(".tgz"))!);
    }
    copyFileSync(tarball, join(context, "youiyoux.tgz"));
    if (tarball.startsWith(context)) rmSync(tarball);
    const build = spawnSync("docker", ["build", "-f", DOCKERFILE, "-t", tag, context], { stdio: "inherit" });
    if (build.status !== 0) throw new Error("docker build failed");
    console.log(`built ${tag}`);
    if (values.smoke) {
      await smoke(tag);
      await smokeWorkspaces(tag);
    }
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`pnpm docker: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
