import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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
    const texts = [publicHelp, ruleBlock(repo.dir), result.stdout, ...["youiyoux-report.html", "youiyoux-summary.md"].map((f) => readFileSync(join(repo.dir, f), "utf8")), ...["README.md", "packages/youiyoux/README.md", "docs/getting-started.md"].map((f) => readFileSync(join(root, f), "utf8"))];
    for (const text of texts) expect(text).not.toMatch(oldCommand);
    for (const file of ["README.md", "packages/youiyoux/README.md"]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text).toContain("~/.cache/youiyoux/specimens");
      expect(text).toContain("relative paths, component names, class lists, counts and rendered images");
    }
  } finally { repo.remove(); }
});

test("the getting-started guide's links reach a file and a heading that exist", () => {
  const guide = readFileSync(join(root, "docs/getting-started.md"), "utf8");
  const slug = (heading: string) => heading.toLowerCase().replace(/[`()]/g, "").replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
  const links = [...guide.matchAll(/\]\(([^)#\s]+\.md)(?:#([^)]+))?\)/g)].filter(([, file]) => !/^https?:/.test(file!));
  expect(links.length).toBeGreaterThan(3);
  for (const [, file, anchor] of links) {
    const text = readFileSync(join(root, "docs", file!), "utf8");
    if (anchor) expect([...text.matchAll(/^#+ (.+)$/gm)].map(([, h]) => slug(h!)), `${file}#${anchor}`).toContain(anchor);
  }
});

test("the README's images are real files in docs/images, and its links into docs reach headings that exist", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const slug = (heading: string) => heading.toLowerCase().replace(/[`()]/g, "").replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-");
  const headings = (file: string) => [...readFileSync(join(root, file), "utf8").matchAll(/^#+ (.+)$/gm)].map(([, h]) => slug(h!));
  const images = [...readme.matchAll(/<img src="([^"]+)"/g)].map(([, src]) => src!);
  expect(images).toContain("docs/images/hub-behaviour.png");
  for (const src of images) expect(statSync(join(root, src)).size, src).toBeGreaterThan(10_000);
  const links = [...readme.matchAll(/\]\(((?:docs\/)?[^)#\s]*\.md)?#([^)]+)\)/g)];
  expect(links.map(([, file, anchor]) => `${file ?? ""}#${anchor}`)).toEqual(expect.arrayContaining(["docs/commands.md#behaviour-checks", "#check-your-popups-work-with-a-keyboard"]));
  for (const [, file, anchor] of links) expect(headings(file ?? "README.md"), `${file ?? "README.md"}#${anchor}`).toContain(anchor);
  // The behaviour docs' cross-links between commands.md and agents.md.
  expect(headings("docs/agents.md")).toContain("checking-popups-ui_behave");
  expect(readFileSync(join(root, "docs/commands.md"), "utf8")).toContain("(agents.md#checking-popups-ui_behave)");
  expect(readFileSync(join(root, "docs/agents.md"), "utf8")).toContain("(#checking-popups-ui_behave)");
});
