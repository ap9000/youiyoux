/**
 * The self-hosted hub's image and Compose file (docker/): what a team relies on when it runs them,
 * read from the files themselves. Building and running the image is CI's docker job
 * (`pnpm docker --smoke`); nothing here needs Docker or the network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { CiRecord } from "@youiyoux/core";
import { BRANCHES_ENV } from "../../packages/cli/src/github-oidc.ts";
import { CLIENT_ID_ENV, CLIENT_SECRET_ENV } from "../../packages/cli/src/github-signin.ts";
import { AUDIENCE_ENV, GITHUB_OWNERS_ENV, VIEW_KEY_ENV } from "../../packages/cli/src/org-hub.ts";
import { HUB_TOKEN_ENV } from "../../packages/cli/src/record.ts";
import { smokeRecord } from "../docker.ts";

const root = join(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const dockerfile = read("docker/Dockerfile");
const composeText = read("docker/compose.yml");
const compose = parse(composeText) as { services: Record<string, { image: string; environment?: Record<string, string>; ports?: string[]; profiles?: string[]; command?: string[] }> };
const example = read("docker/.env.example");
/** The variables .env.example sets, with their values. */
const exampleVars = new Map(example.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const instruction = (name: string): string[] => dockerfile.split("\n").filter((l) => l.startsWith(`${name} `));

describe("docker/Dockerfile", () => {
  test("Node new enough for the SQLite store (22.5 or later), and the Postgres driver @youiyoux/store pins", () => {
    const [from] = instruction("FROM");
    const [major, minor] = /node:(\d+)\.(\d+)/.exec(from!)!.slice(1).map(Number) as [number, number];
    expect(major > 22 || (major === 22 && minor >= 5)).toBe(true);
    const pg = (JSON.parse(read("packages/store/package.json")) as { dependencies: Record<string, string> }).dependencies.pg;
    expect(dockerfile).toContain(` pg@${pg} `);
  });

  test("runs as the node user, keeps its SQLite file on the /data volume, listens beyond the container, and checks its health", () => {
    const lines = dockerfile.split("\n");
    const user = lines.findIndex((l) => l === "USER node");
    expect(user).toBeGreaterThan(lines.findIndex((l) => l.startsWith("RUN ")));
    expect(user).toBeLessThan(lines.findIndex((l) => l.startsWith("CMD ")));
    expect(dockerfile).toMatch(/YOUI_HUB_DB=\/data\/hub\.db/);
    expect(instruction("VOLUME")).toEqual(["VOLUME /data"]);
    expect(dockerfile).toContain("chown node:node /data");
    expect(JSON.parse(instruction("CMD")[0]!.slice(4))).toEqual(["youiyoux", "hub", "serve", "--host", "0.0.0.0"]);
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*\/api\/health/);
  });

  test("installs only the tarball it is given: no checkout copied in", () => {
    expect(instruction("COPY")).toEqual(["COPY youiyoux.tgz /tmp/youiyoux.tgz"]);
  });
});

describe("docker/compose.yml", () => {
  const hub = compose.services.hub!;

  test("the hub reads the environment variables the hub serve command does, by their names", () => {
    expect(Object.keys(hub.environment!).sort()).toEqual(["DATABASE_URL", VIEW_KEY_ENV, CLIENT_ID_ENV, CLIENT_SECRET_ENV, GITHUB_OWNERS_ENV, AUDIENCE_ENV, BRANCHES_ENV, HUB_TOKEN_ENV].sort());
    expect(hub.environment!.DATABASE_URL).toMatch(/^postgres:\/\/youiyoux:\$\{POSTGRES_PASSWORD:\?[^}]+\}@db:5432\/youiyoux$/);
  });

  test("secrets come from .env, the database's required there; none is written in the file", () => {
    // The view key or the OAuth App: which one is the hub's to check (youiyoux hub serve refuses to start without either).
    expect(compose.services.db!.environment!.POSTGRES_PASSWORD).toMatch(/^\$\{POSTGRES_PASSWORD:\?/);
    for (const [name, value] of Object.entries(hub.environment!)) expect(value, name).toMatch(/\$\{/);
  });

  test("only Caddy, in the https profile, listens beyond this machine; Postgres not at all", () => {
    expect(hub.ports).toEqual(["127.0.0.1:${YOUIYOUX_PORT:-8080}:8080"]);
    expect(compose.services.db!.ports).toBeUndefined();
    expect(compose.services.proxy!.profiles).toEqual(["https"]);
    // Compose reads every profile's variables, so the proxy refuses an empty domain itself, when it starts.
    expect(compose.services.proxy!.command!.join(" ")).toMatch(/test -n "\$\$YOUIYOUX_DOMAIN" \|\|/);
    expect(read("docker/Caddyfile")).toMatch(/^\{\$YOUIYOUX_DOMAIN\} \{\n\treverse_proxy hub:8080\n\}/m);
  });

  test("the image is the one the release workflow publishes", () => {
    expect(hub.image).toBe("ghcr.io/ap9000/youiyoux:${YOUIYOUX_VERSION:-latest}");
    expect(read(".github/workflows/release.yml")).toContain("ghcr.io/${{ github.repository_owner }}/youiyoux");
  });

  test("a release re-run for a version already on npm skips the npm environment and still pushes the image", () => {
    type Job = { needs?: string[]; if?: string; outputs?: Record<string, string>; environment?: string; steps: Array<{ id?: string; run?: string }> };
    const { jobs } = parse(read(".github/workflows/release.yml")) as { jobs: Record<string, Job> };
    expect(jobs.build!.outputs?.published).toBe("${{ steps.npm.outputs.published }}");
    expect(jobs.build!.steps.find((s) => s.id === "npm")?.run).toContain('npm view "youiyoux@$VERSION" version');
    expect(jobs.publish!.environment).toBe("npm");
    expect(jobs.publish!.if).toBe("needs.build.outputs.published != 'true'");
    // A job that needs a skipped job is skipped too, unless its condition says otherwise.
    for (const name of ["image", "release"]) expect(jobs[name]!.if, name).toMatch(/needs\.build\.result == 'success'.*\["success", "skipped"\].*needs\.publish\.result/);
  });

  test("a workflow job that checks out the repo without installing pnpm sets up Node without pnpm's cache", () => {
    // setup-node reads package.json's packageManager and fails the job when that pnpm is not on PATH.
    for (const file of ["ci.yml", "release.yml", "web-preview.yml"]) {
      const workflow = parse(read(`.github/workflows/${file}`)) as { jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, unknown> }> }> };
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const uses = (action: string) => job.steps.some((s) => s.uses?.startsWith(action));
        if (!uses("actions/checkout") || uses("pnpm/action-setup")) continue;
        for (const step of job.steps.filter((s) => s.uses?.startsWith("actions/setup-node"))) expect(step.with?.["package-manager-cache"], `${file} ${name}`).toBe(false);
      }
    }
  });
});

describe("docker/.env.example", () => {
  test("names every variable compose.yml reads, with no secret filled in, and docker/.env is kept out of git", () => {
    const used = new Set([...composeText.matchAll(/\$\{([A-Z_]+)[:}]/g)].map((m) => m[1]!));
    expect([...used].filter((name) => !exampleVars.has(name))).toEqual([]);
    for (const secret of ["POSTGRES_PASSWORD", VIEW_KEY_ENV, HUB_TOKEN_ENV, CLIENT_SECRET_ENV]) expect(exampleVars.get(secret), secret).toBe("");
    expect(read(".gitignore").split("\n")).toContain("docker/.env");
  });
});

describe("pnpm docker --smoke", () => {
  test("sends a record the hub accepts (youi.record/v1)", () => {
    expect(CiRecord.safeParse(smokeRecord(new Date("2026-10-25T12:00:00Z"))).success).toBe(true);
  });
});
