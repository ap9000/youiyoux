import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ruleBlock } from "../src/agents-install.ts";
import { COMMAND } from "../src/command.ts";
import { fixtureRepo, report, singleFiles } from "./report-fixtures.ts";

const root = join(import.meta.dirname, "../../..");
const oldCommand = /\byoui\s+(?:scan|watch|rules|check|render|agents|sync|inventory|detect|discover|hooks|mcp|init|show|plan|migrate|index|build|where|bom|schema|ui|report|library|baseline|parity|<command>)/;

test("help, instructions, report and README use youiyoux; youi is a silent alias (c11)", async () => {
  const repo = fixtureRepo("rename", singleFiles());
  try {
    const publicHelp = execFileSync(process.execPath, [join(root, "packages/cli/bin/youiyoux.js"), "--help"], { encoding: "utf8" });
    const aliasHelp = execFileSync(process.execPath, [join(root, "packages/cli/bin/youi.js"), "--help"], { encoding: "utf8" });
    expect(aliasHelp).toBe(publicHelp);
    expect(publicHelp).toContain(`${COMMAND} <command>`);
    const result = await report(repo.dir);
    const texts = [publicHelp, ruleBlock(repo.dir), result.stdout, ...["youiyoux-report.html", "youiyoux-summary.md"].map((f) => readFileSync(join(repo.dir, f), "utf8")), ...["README.md", "packages/youiyoux/README.md"].map((f) => readFileSync(join(root, f), "utf8"))];
    for (const text of texts) expect(text).not.toMatch(oldCommand);
    for (const file of ["README.md", "packages/youiyoux/README.md"]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text).toContain("~/.cache/youiyoux/specimens");
      expect(text).toContain("relative paths, component names, class lists, counts and rendered images");
    }
  } finally { repo.remove(); }
});
