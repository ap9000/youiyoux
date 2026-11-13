import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildInventory, escapeRegExp, parseModule, parseProblem } from "../src/index.ts";

/** A bare `&` in JSX text: tsc accepts it; the bundled tree-sitter grammar reads only `&name;`. */
const AMPERSAND = `export function Tabs() {
  return (
    <nav>
      <button className="px-3 py-1 rounded-md">Contract & tokens</button>
    </nav>
  );
}
`;

/** `using` as an ordinary name: the grammar takes it for a \`using\` declaration. */
const USING = `import { useState } from "react";

export function OfferPanel() {
  const [using, setUsing] = useState<string | null>(null);
  return <div>{using && <button className="px-3 py-1 rounded-md" onClick={() => setUsing(null)}>Use this</button>}</div>;
}
`;

const GENERIC = "Next: fix the syntax there; if TypeScript accepts it, youiyoux's parser does not support that syntax yet: report it, and write it another way meanwhile";
const problemOf = async (file: string, source: string) => parseProblem((await parseModule(file, source))!, "UI elements there were not read");

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

describe("valid TypeScript the parser cannot read is named, with its line and the rewrite", () => {
  test("a bare & in JSX text", async () => {
    expect(await problemOf("src/Tabs.tsx", AMPERSAND)).toBe(
      `the parser could not read line 4, so UI elements there were not read. Next: line 4: the parser youiyoux uses can't read a bare & in JSX text; write &amp; or {"&"} there`,
    );
  });

  test("using as a variable name", async () => {
    expect(await problemOf("src/Offers.tsx", USING)).toMatch(/^the parser could not read lines? [\d, -]+, so UI elements there were not read\. Next: line 4: the parser youiyoux uses can't read `using` as a variable name; rename it$/);
  });

  test("a real using declaration parses and is never called a name", async () => {
    expect(await problemOf("src/res.ts", "export function read() {\n  using handle = open();\n  return handle;\n}\n")).toBeNull();
    // Beside an unrelated error, or as a broken `await using`, the Next stays generic.
    expect(await problemOf("src/res.ts", "export function read() {\n  using handle = open();\n  return 1 +* 2;\n}\n")).toBe(`the parser could not read line 3, so UI elements there were not read. ${GENERIC}`);
    expect(await problemOf("src/res.ts", "export async function read() {\n  await using = foo();\n}\n")).toMatch(new RegExp(`${escapeRegExp(GENERIC)}$`));
  });

  test("an unrelated syntax error gets the generic Next with its line; &&, &amp; and a stray & outside JSX are not a bare & in JSX text", async () => {
    const source = `export function Panel() {\n  return <div>{a && b}</div>;\n}\nexport const bad = 1 & * 2;\nexport const ok = <b>Tom &amp; Jerry</b>;\n`;
    expect(await problemOf("src/Panel.tsx", source)).toBe(`the parser could not read line 4, so UI elements there were not read. ${GENERIC}`);
  });

  test("an error that swallows the file says so instead of naming a line", async () => {
    // An unclosed JSX element: nothing after it can be read.
    const source = `function A() { return <div>\n${"export const B = () => <b>x</b>;\n".repeat(20)}}\n`;
    expect(await problemOf("src/swallowed.tsx", source)).toMatch(/^the parser could not read most of the file, so UI elements there were not read\. Next: /);
  });
});

describe("the inventory", () => {
  test("keeps such a file partial with the named fix, and reads it fully once rewritten", async () => {
    const broken = await project({ "src/Tabs.tsx": AMPERSAND, "src/Offers.tsx": USING });
    const before = await buildInventory([broken], { cwd: broken });
    expect(before.projects[0]!.status).toBe("partial");
    expect(before.projects[0]!.failed.map((f) => `${f.file}: ${f.reason.replace(/^.*Next: /, "")}`).sort()).toEqual([
      "src/Offers.tsx: line 4: the parser youiyoux uses can't read `using` as a variable name; rename it",
      `src/Tabs.tsx: line 4: the parser youiyoux uses can't read a bare & in JSX text; write &amp; or {"&"} there`,
    ]);

    const fixed = await project({ "src/Tabs.tsx": AMPERSAND.replace(" & ", " &amp; "), "src/Offers.tsx": USING.replace(/\busing\b/g, "choosing").replace("setUsing", "setChoosing") });
    const after = await buildInventory([fixed], { cwd: fixed });
    expect(after.projects[0]!.failed).toEqual([]);
    expect(after.projects[0]!.status).toBe("complete");
    expect(after.definitions.map((d) => d.name).sort()).toEqual(["OfferPanel", "Tabs"]);
    // The label is the rendered text: the reference decoded and joined to the words around it.
    expect(after.looks.filter((l) => l.tag === "button").map((l) => `${l.file}:${l.line} ${l.recipe?.label}`).sort()).toEqual(["src/Offers.tsx:5 Use this", "src/Tabs.tsx:4 Contract & tokens"]);
  });

  test("a label with references reads as rendered", async () => {
    const dir = await project({ "src/Note.tsx": `export function Note() {\n  return <button className="px-3">The app&rsquo;s &#8220;dev&#x201D; server</button>;\n}\n` });
    const report = await buildInventory([dir], { cwd: dir });
    expect(report.looks.find((l) => l.tag === "button")?.recipe?.label).toBe("The app’s “dev” server");
  });
});
