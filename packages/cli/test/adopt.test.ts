/**
 * A System inside the product: its contracts, tokens and rules in the product's repo, its
 * implementations the product's own components, never copied.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { loadProject } from "@youiyoux/scanner";
import { syncProject, verifyLock } from "../src/sync.ts";

const EXAMPLES = join(import.meta.dirname, "../../../examples");

let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "youi-adopt-")));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The demo app holding the demo system itself: contracts under design/, implementations in components/ui. */
async function inPlace(name: string): Promise<string> {
  const root = join(dir, name);
  await cp(join(EXAMPLES, "demo-app"), root, { recursive: true });
  const design = join(EXAMPLES, "demo-design");
  await cp(join(design, "tokens"), join(root, "design/tokens"), { recursive: true });
  await cp(join(design, "rules"), join(root, "design/rules"), { recursive: true });
  for (const folder of (await readdir(join(design, "components"))).filter((f) => !f.startsWith("_"))) {
    const contract = JSON.parse(await readFile(join(design, "components", folder, `${folder}.contract.json`), "utf8")) as { source: { file: string } };
    await mkdir(join(root, "design/components", folder), { recursive: true });
    await writeFile(join(root, "design/components", folder, `${folder}.contract.json`), JSON.stringify({ ...contract, $schema: undefined, source: { ...contract.source, file: contract.source.file.split("/").at(-1) } }));
  }
  const config = JSON.parse(await readFile(join(design, "youi.config.json"), "utf8")) as { systems: Record<string, unknown>[] };
  const system = { ...config.systems[0], tokens: "design/tokens/demo/demo.resolver.json", components: "design/components", implementations: "components/ui", support: ["utils.ts"], rules: "design/rules", design: undefined };
  await writeFile(join(root, "youi.config.json"), JSON.stringify({ schema: "youi.config/v1", name: name, systems: [system] }));
  const project = JSON.parse(await readFile(join(root, "youi.project.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(root, "youi.project.json"), JSON.stringify({ ...project, $schema: undefined, source: { path: "." } }));
  return root;
}

describe("a System inside the product", () => {
  test("sync copies none of its implementations and locks none: editing a component is changing the System, never drift", async () => {
    const root = await inPlace("in-place-app");
    const before = await readFile(join(root, "components/ui/button.tsx"), "utf8");
    const project = await loadProject(root);
    expect(project.repo.root).toBe(root);
    expect(project.system.components.map((c) => c.contract.name).sort()).toEqual(["Button", "Card", "Input"]);
    const { actions, lock } = await syncProject(project);
    expect(actions.filter((a) => a.role === "component").map((a) => [a.file, a.detail])).toEqual(
      ["button.tsx", "card.tsx", "input.tsx", "utils.ts"].map((f) => [`components/ui/${f}`, "the system's own implementation, in this project"]),
    );
    expect(Object.keys(lock.files).filter((f) => f.startsWith("components/"))).toEqual([]);
    expect(await readFile(join(root, "components/ui/button.tsx"), "utf8")).toBe(before);
    // Tokens and the agent files are still generated from the System.
    expect(await readFile(join(root, "src/design/tokens.css"), "utf8")).toContain("--demo-color-accent");
    await writeFile(join(root, "components/ui/button.tsx"), `${before}\n// a change to the System's Button\n`);
    expect(await verifyLock(await loadProject(root))).toEqual([]);
  });
});
