import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildInventory, countParseErrors, parseModule, parseProblem } from "../src/index.ts";

/** A bare `&` in JSX text: tsc accepts it; the bundled tree-sitter grammar reads only `&name;`. */
const AMPERSAND = `export function Tabs() {
  return (
    <nav>
      <button className="px-3 py-1 rounded-md">Contract & tokens</button>
      <button className="px-3 py-1 rounded-md">Rules</button>
    </nav>
  );
}
`;

/** `using` as an ordinary name: the grammar takes it for a \`using\` declaration and loses the whole file. */
const USING = `import { useState } from "react";

export function OfferPanel({ onUse }: { onUse: (id: string) => void }) {
  const [using, setUsing] = useState<string | null>(null);
  if (using === "x") setUsing(null);
  const state = { using };
  return (
    <div>
      {using && <span>{using}</span>}
      <button className="px-3 py-1 rounded-md" onClick={() => onUse(state.using ?? "")}>Use this</button>
    </div>
  );
}
`;

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "youi-parse-"));
  temps.push(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", dependencies: { react: "19.0.0" } }));
  await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }));
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), source);
  }
  return dir;
}

describe("syntax tsc accepts that the grammar does not", () => {
  test("a bare & in JSX text parses, and its text reads back as written", async () => {
    const module = (await parseModule("src/Tabs.tsx", AMPERSAND))!;
    expect(module.parseErrors).toBe(0);
    expect(module.jsx.map((j) => j.tag)).toEqual(["nav", "button", "button"]);
    // The tree was built from a stand-in; restore gives back the source exactly.
    expect(module.restore(module.root.root().text())).toBe(AMPERSAND);
    expect(await countParseErrors("src/Tabs.tsx", AMPERSAND)).toBe(0);
  });

  test("using as a name parses: the component, its exports and its elements are all read", async () => {
    const module = (await parseModule("src/Offers.tsx", USING))!;
    expect(module.parseErrors).toBe(0);
    expect(module.exports).toEqual([{ kind: "local", name: "OfferPanel", local: "OfferPanel" }]);
    expect([...module.declarations]).toEqual(["OfferPanel"]);
    expect(module.jsx.map((j) => j.tag)).toEqual(["div", "span", "button"]);
    expect(module.restore(module.root.root().text())).toBe(USING);
  });

  test("a real using declaration is left alone, and names come back as written", async () => {
    const source = `export function read() {\n  using handle = open();\n  const [using, setUsing] = pair();\n  if (using) setUsing(handle);\n}\nexport const using = 1;\n`;
    const module = (await parseModule("src/res.ts", source))!;
    expect(module.parseErrors).toBe(0);
    expect(module.exports.map((e) => e.name)).toEqual(["read", "using"]);
    const tree = module.root.root().text();
    // Only the names were stood in for; the declaration keeps its keyword.
    expect(tree).toContain("  using handle = open();");
    expect(tree).not.toContain("const [using,");
    expect(module.restore(tree)).toBe(source);
  });

  test("an edit committed on a worked-around file writes the source's own text back", async () => {
    const module = (await parseModule("src/Offers.tsx", `${USING}export const T = () => <b>Save & close</b>;\n`))!;
    const button = module.jsx.find((j) => j.tag === "button")!.node;
    const label = button.field("name")!;
    const out = module.restore(module.root.root().commitEdits([label.replace("Button")]));
    expect(out).toContain("<Button className=");
    expect(out).toContain("const [using, setUsing]");
    expect(out).toContain("<b>Save & close</b>");
    expect(out).not.toMatch(/[-]/);
  });

  test("a real syntax error is still one, with where it is and what to do", async () => {
    const source = `export const A = () => <span broken={;\n`;
    const module = (await parseModule("src/broken.tsx", source))!;
    expect(module.parseErrors).toBeGreaterThan(0);
    expect(parseProblem(module, "UI elements there were not read")).toMatch(/^the parser could not read (?:line 1|most of the file), so UI elements there were not read\. Next: fix the syntax there; if TypeScript accepts it/);
  });

  test("the inventory reads both files fully: the component, its looks and the label with its &", async () => {
    const dir = await project({ "src/Tabs.tsx": AMPERSAND, "src/Offers.tsx": USING });
    const report = await buildInventory([dir], { cwd: dir });
    expect(report.projects[0]!.failed).toEqual([]);
    expect(report.projects[0]!.status).toBe("complete");
    expect(report.definitions.map((d) => d.name).sort()).toEqual(["OfferPanel", "Tabs"]);
    const labels = report.looks.filter((l) => l.tag === "button").map((l) => `${l.file}:${l.line} ${l.recipe?.label}`);
    expect(labels).toEqual(expect.arrayContaining(["src/Tabs.tsx:4 Contract & tokens", "src/Tabs.tsx:5 Rules", "src/Offers.tsx:10 Use this"]));
  });
});

describe("a file the parser cannot read is reported, never counted as clean", () => {
  test("the inventory names the file, the lines it could not read, and the next step", async () => {
    const broken = `export function Panel() {\n  return <div>\n    <button className="px-3">ok</button>\n  </div>;\n}\nexport const bad = 1 +* 2;\n${"export const B = () => <b>x</b>;\n".repeat(20)}`;
    const dir = await project({ "src/Panel.tsx": broken, "src/Tabs.tsx": AMPERSAND });
    const report = await buildInventory([dir], { cwd: dir });
    expect(report.projects[0]!.status).toBe("partial");
    expect(report.projects[0]!.failed).toEqual([{ file: "src/Panel.tsx", reason: expect.stringMatching(/^the parser could not read line 6, so UI elements there were not read\. Next: fix the syntax there; /) }]);
  });

  test("an error that swallows the file says so instead of naming a line", async () => {
    // An unclosed JSX element: nothing after it can be read.
    const source = `function A() { return <div>\n${"export const B = () => <b>x</b>;\n".repeat(20)}}\n`;
    const module = (await parseModule("src/swallowed.tsx", source))!;
    expect(module.parseErrors).toBeGreaterThan(0);
    expect(parseProblem(module, "UI elements there were not read")).toMatch(/^the parser could not read most of the file, /);
  });
});
