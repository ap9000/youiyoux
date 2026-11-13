/**
 * Another youiyoux process running a behaviour run (behaviour-processes.test.ts): it takes the route
 * through runBehaviour with the stand-in probe, says "probing" once it holds the run, and finishes
 * only when the release file appears. Args: product root, design root, route, release file.
 */
import { existsSync } from "node:fs";
import { loadProject } from "@youiyoux/scanner";
import { runBehaviour } from "../../src/index.ts";
import { control, setup, standIn } from "../behaviour-stand-in.ts";

const [root, design, route, release] = process.argv.slice(2) as [string, string, string, string];
control.verdict = "passed";
// Says so once it holds the run (the route's claim is taken before the probe starts), then waits.
const held: typeof standIn = async (options) => {
  console.log("probing");
  while (!existsSync(release)) await new Promise((done) => setTimeout(done, 20));
  return standIn(options);
};
const project = await loadProject(root, { designRoot: design });
const { done } = await runBehaviour(project, { ...setup, probe: held }, { route, by: "agent" });
const { run } = await done;
console.log(JSON.stringify({ runId: run.runId }));
