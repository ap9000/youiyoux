/**
 * `youiyoux library ingest <link>`: what a link holds, shown, and with --draft filed as one
 * ingest draft in the product's queue (the hub's Changes page reviews it). A local DESIGN.md is
 * read here, so nothing touches the network.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { FileStore } from "@youiyoux/workflow";
import { main } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });

const DESIGN_MD = ["---", "name: Acme", "colors:", "  primary: '#5e6ad2'", "components:", "  button: { backgroundColor: '{colors.primary}' }", "---", "", "# Acme", "", "## Components", "", "### Dialog", "", "One question at a time."].join("\n");

let dir: string;
let out = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-ingest-cli-")));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});
const quiet = (): void => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
};

describe("youiyoux library ingest", () => {
  test("shows what a DESIGN.md holds, by kind and role, and how to file it; nothing is written", async () => {
    const file = join(dir, "DESIGN.md");
    await writeFile(file, DESIGN_MD);
    quiet();
    expect(await main(["library", "ingest", file])).toBe(0);
    expect(out).toContain("Acme · design-md · 3 items · licence unknown");
    expect(out).toMatch(/components\n {2}Button +button +Button, as Acme's DESIGN\.md describes it\n {2}Dialog +dialog +One question at a time\./);
    expect(out).toContain("tokens\n  Colors");
    expect(out).toContain(`Next: youiyoux library ingest ${file} --draft files it for review`);
  });

  test("--draft files one ingest draft in the product's queue, every item kept, for a person to review", async () => {
    const design = join(dir, "design");
    const app = join(dir, "app");
    const state = join(dir, "state");
    await cp(join(EXAMPLES, "demo-design"), design, { recursive: true });
    await cp(join(EXAMPLES, "demo-app"), app, { recursive: true });
    await git(design, "init", "--quiet", "--initial-branch=main");
    await git(design, "add", ".");
    await git(design, "commit", "--quiet", "-m", "start");
    const config = JSON.parse(await readFile(join(app, "youi.project.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(app, "youi.project.json"), JSON.stringify({ ...config, $schema: undefined, source: { path: design } }));
    const file = join(dir, "DESIGN.md");
    await writeFile(file, DESIGN_MD);
    quiet();
    expect(await main(["library", "ingest", file, "--draft", "--project", app, "--state", state])).toBe(0);
    const id = /filed as draft (d-[0-9a-f]+)/.exec(out)?.[1];
    expect(id).toBeDefined();
    const draft = await new FileStore(state).get(id!);
    expect(draft).toMatchObject({ kind: "ingest", content: { keep: ["lib:acme/token/colors", "lib:acme/component/button", "lib:acme/component/dialog"] } });
    // The local file's path is in no item: only its name.
    expect(JSON.stringify(draft!.kind === "ingest" ? draft!.content.reading.entries : [])).not.toContain(dir);
  });
});
