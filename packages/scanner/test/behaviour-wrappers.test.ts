/**
 * Where a popup's button is used (behaviour results' file:line): when the line that renders it is
 * inside a component the code uses in more than one place, the next owner frame, if it is one of that
 * component's uses, read from the source with the scanner's parser and module graph. Never from the
 * page's other triggers; anything uncertain keeps the line that renders the button.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { resolvePlaces, WrapperIndex, type PlaceLine } from "../src/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "youi-wrappers-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  // The hub's case: a local wrapper used three times.
  "src/shell/NavRail.tsx": `function RailButton({ label }: { label: string }) {
  return <button aria-label={label} aria-haspopup="dialog" />;
}
export function NavRail() {
  return (
    <nav>
      <RailButton label="Connect your agent" />
      <RailButton label="Search" />
      <RailButton label="Keyboard shortcuts" />
    </nav>
  );
}
`,
  "src/shell/Shell.tsx": `import { NavRail } from "./NavRail";
export function Shell() {
  return <NavRail />;
}
`,
  // Codex's case: a Row used once (inside List's map), List used twice on the dashboard.
  "src/list/Row.tsx": `export function Row({ name }: { name: string }) {
  return <button aria-haspopup="menu">{name}</button>;
}
`,
  "src/list/List.tsx": `import { Row } from "./Row";
export function List({ rows }: { rows: string[] }) {
  return <ul>{rows.map((r) => <Row key={r} name={r} />)}</ul>;
}
`,
  "src/list/Dashboard.tsx": `import { List } from "./List";
export function Dashboard() {
  return (
    <main>
      <List rows={["a"]} />
      <List rows={["b"]} />
    </main>
  );
}
`,
  // Two local components named Item in different files: A's is used twice, B's once.
  "src/a/A.tsx": `function Item() {
  return <button aria-haspopup="menu" />;
}
export function A() {
  return (
    <div>
      <Item />
      <Item />
    </div>
  );
}
`,
  "src/b/B.tsx": `function Item() {
  return <button aria-haspopup="menu" />;
}
export function B() {
  return <Item />;
}
`,
  // Chip, used only under other names: renamed, through a path alias, and as a namespace member through a barrel.
  "src/kit/Chip.tsx": `export function Chip() {
  return <button aria-haspopup="menu" />;
}
`,
  "src/kit/index.ts": `export { Chip } from "./Chip";
`,
  "src/alias/X.tsx": `import { Chip as C } from "../kit/Chip";
export function X() {
  return <C />;
}
`,
  "src/alias/Y.tsx": `import { Chip as Tag } from "@/kit/Chip";
export function Y() {
  return <Tag />;
}
`,
  "src/alias/Z.tsx": `import * as kit from "@/kit";
export function Z() {
  return <kit.Chip />;
}
`,
  // A wrapper whose button is drawn in a .map callback (its own stack has a line inside it first).
  "src/menu/Menu.tsx": `export function Menu({ items }: { items: string[] }) {
  return (
    <div>
      {items.map((i) => (
        <button key={i} aria-haspopup="menu">{i}</button>
      ))}
    </div>
  );
}
export function Menus() {
  return (
    <>
      <Menu items={["a"]} />
      <Menu items={["b"]} />
    </>
  );
}
`,
  // A wrapper in a file that doesn't parse cleanly, used twice from clean files.
  "src/broken/Wobbly.tsx": `export function Wobbly() {
  return <button aria-haspopup="menu" />;
}
const oops = (;
`,
  "src/broken/UsesWobbly.tsx": `import { Wobbly } from "./Wobbly";
export function UsesWobbly() {
  return (
    <div>
      <Wobbly />
      <Wobbly />
    </div>
  );
}
`,
  // A wrapper used once in a clean file and once in a broken one.
  "src/half/Half.tsx": `export function Half() {
  return <button aria-haspopup="menu" />;
}
export function UsesHalf() {
  return <Half />;
}
`,
  "src/half/Elsewhere.tsx": `import { Half } from "./Half";
export function Elsewhere() {
  return <div><Half /></div>;
}
const oops = (;
`,
  // A wrapper used twice, but only through a barrel outside the project root: not read through.
  "src/far/Far.tsx": `export function Far() {
  return <button aria-haspopup="menu" />;
}
`,
  "src/far/UsesFar.tsx": `import { Far } from "../../../outside/barrel";
export function UsesFar() {
  return <div><Far /><Far /></div>;
}
`,
  // A button at the top level of a module, in no component.
  "src/loose/loose.tsx": `export const loose = <button aria-haspopup="menu" />;
`,
  // Outside the include globs.
  "other/Wrapper.tsx": `function Wrap() {
  return <button aria-haspopup="menu" />;
}
export function Two() {
  return <div><Wrap /><Wrap /></div>;
}
`,
};

const root = join(scratch, "app");
for (const [file, text] of Object.entries(FILES)) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
// ../outside/barrel.ts beside the project root re-exports Far: a file no result is fresh against.
mkdirSync(join(scratch, "outside"), { recursive: true });
writeFileSync(join(scratch, "outside/barrel.ts"), 'export { Far } from "../app/src/far/Far";\n');
const sources = { root, include: ["src/**/*.{ts,tsx}"], exclude: [], tsconfig: "tsconfig.json" };
/** The line of `file` holding `needle` (the nth match), as a frame's line. */
const at = (file: string, needle: string, nth = 0): PlaceLine => {
  const line = FILES[file]!.split("\n").flatMap((text, i) => (text.includes(needle) ? [i + 1] : []))[nth];
  if (!line) throw new Error(`no ${needle} in ${file}`);
  return { file, line, column: 1 };
};
const show = (l: PlaceLine | null) => (l ? `${l.file}:${l.line}` : null);

describe("where a popup's button is used", () => {
  const index = new WrapperIndex(sources);
  const rail = at("src/shell/NavRail.tsx", "<button");

  test("a wrapper outside componentsDir used in three places: each trigger at its own use", async () => {
    for (const [n, label] of ["Connect your agent", "Search", "Keyboard shortcuts"].entries()) {
      const use = at("src/shell/NavRail.tsx", `label="${label}"`);
      expect(show(await index.usage(rail, [use, at("src/shell/Shell.tsx", "<NavRail")]))).toBe(`src/shell/NavRail.tsx:${7 + n}`);
    }
  });

  test("a component used in one place keeps its own line: Codex's two lists, whatever their rows", async () => {
    const button = at("src/list/Row.tsx", "<button");
    const left = [at("src/list/List.tsx", "<Row"), at("src/list/Dashboard.tsx", "<List", 0)];
    const right = [at("src/list/List.tsx", "<Row"), at("src/list/Dashboard.tsx", "<List", 1)];
    expect(show(await index.usage(button, left))).toBeNull();
    expect(show(await index.usage(button, right))).toBeNull();
  });

  test("the answer depends only on the code: the same frames give the same line however many triggers the screen has", async () => {
    // Source-mapped frames for each row's button: Row's <button>, List's map, Dashboard's <List> (left or right).
    const MAP: ReadonlyArray<readonly [string, number]> = [
      ["src/list/Row.tsx", at("src/list/Row.tsx", "<button").line],
      ["src/list/List.tsx", at("src/list/List.tsx", "<Row").line],
      ["src/list/Dashboard.tsx", at("src/list/Dashboard.tsx", "<List", 0).line],
      ["src/list/Dashboard.tsx", at("src/list/Dashboard.tsx", "<List", 1).line],
    ];
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const vlq = (n: number): string => {
      let v = n < 0 ? (-n << 1) | 1 : n << 1;
      let out = "";
      do {
        let digit = v & 31;
        v >>>= 5;
        if (v) digit |= 32;
        out += B64[digit];
      } while (v);
      return out;
    };
    const files = [...new Set(MAP.map(([f]) => f))];
    let previous = { source: 0, line: 0 };
    const mappings = MAP.map(([file, line]) => {
      const source = files.indexOf(file);
      const segment = vlq(0) + vlq(source - previous.source) + vlq(line - 1 - previous.line) + vlq(0);
      previous = { source, line: line - 1 };
      return segment;
    }).join(";");
    const module = `${MAP.map(() => "x").join("\n")}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: files.map((f) => `/${f}`), mappings })).toString("base64")}`;
    const fetchText = async (url: string) => (url.startsWith("http://localhost/app.js") ? module : null);
    const row = (name: string, list: 3 | 4) => ({ name, owner: null, frames: [1, 2, list].map((line) => ({ url: "http://localhost/app.js", line, column: 1 })), box: { x: 0, y: 0, width: 1, height: 1 }, depth: 0 });
    const resolve = async (places: ReturnType<typeof row>[]) => (await resolvePlaces(places, fetchText, null, undefined, undefined, { promote: (first, rest) => new WrapperIndex(sources).usage(first, rest) })).map((p) => [p.name, `${p.file}:${p.line}`, p.renderedBy ?? null]);
    const one = await resolve([row("Left a", 3), row("Right b", 4)]);
    const two = await resolve([row("Left a", 3), row("Left c", 3), row("Right b", 4)]);
    expect(one).toEqual([
      ["Left a", "src/list/Row.tsx:2", null],
      ["Right b", "src/list/Row.tsx:2", null],
    ]);
    expect(two.filter(([name]) => name !== "Left c")).toEqual(one);
  });

  test("a plain inline button is unchanged: the component holding it is used once, or the button is in no component", async () => {
    // Row's button is written inline in Row, used once (above); a button outside any component:
    expect(await index.usage(at("src/loose/loose.tsx", "<button"), [at("src/shell/Shell.tsx", "<NavRail")])).toBeNull();
  });

  test("two components of the same name in different files are counted apart", async () => {
    const a = at("src/a/A.tsx", "<button");
    const b = at("src/b/B.tsx", "<button");
    expect(show(await index.usage(a, [at("src/a/A.tsx", "<Item", 1)]))).toBe("src/a/A.tsx:8");
    // B's Item is used once: A's two uses aren't B's.
    expect(await index.usage(b, [at("src/b/B.tsx", "<Item")])).toBeNull();
    // And A's frames never land on B's use.
    expect(await index.usage(a, [at("src/b/B.tsx", "<Item")])).toBeNull();
  });

  test("a component imported under other names is counted at each use: renamed, through a path alias, a barrel and a namespace", async () => {
    const chip = at("src/kit/Chip.tsx", "<button");
    expect(show(await index.usage(chip, [at("src/alias/X.tsx", "<C")]))).toBe("src/alias/X.tsx:3");
    expect(show(await index.usage(chip, [at("src/alias/Y.tsx", "<Tag")]))).toBe("src/alias/Y.tsx:3");
    expect(show(await index.usage(chip, [at("src/alias/Z.tsx", "<kit.Chip")]))).toBe("src/alias/Z.tsx:3");
  });

  test("lines inside the component itself (a .map callback) are its own stack and passed over; only one hop", async () => {
    const button = at("src/menu/Menu.tsx", "<button");
    const own = at("src/menu/Menu.tsx", "items.map");
    expect(show(await index.usage(button, [own, at("src/menu/Menu.tsx", "<Menu", 1)]))).toBe("src/menu/Menu.tsx:14");
    // A use of the component is taken only as the next frame: never further up past something else.
    expect(await index.usage(rail, [at("src/shell/Shell.tsx", "<NavRail"), at("src/shell/NavRail.tsx", 'label="Search"')])).toBeNull();
  });

  test("anything uncertain keeps the line: next frame not a use, a System line next, a broken file, a use in a broken file, a file outside the globs", async () => {
    expect(await index.usage(rail, [at("src/shell/Shell.tsx", "<NavRail")])).toBeNull();
    expect(await index.usage(rail, [])).toBeNull();
    expect(await index.usage(rail, [{ ...at("src/shell/NavRail.tsx", 'label="Search"'), skipped: true }])).toBeNull();
    expect(await index.usage(at("src/broken/Wobbly.tsx", "<button"), [at("src/broken/UsesWobbly.tsx", "<Wobbly")])).toBeNull();
    expect(await index.usage(at("src/half/Half.tsx", "<button"), [at("src/half/Half.tsx", "<Half")])).toBeNull();
    expect(await index.usage(at("other/Wrapper.tsx", "<button"), [at("other/Wrapper.tsx", "<Wrap")])).toBeNull();
    expect(await index.usage(at("src/far/Far.tsx", "<button"), [at("src/far/UsesFar.tsx", "<Far")])).toBeNull();
  });

  test("the sources are read once per index (one behaviour run): a later edit is seen by the next run, not mid-run", async () => {
    const run = new WrapperIndex(sources);
    const use = at("src/shell/NavRail.tsx", 'label="Search"');
    expect(show(await run.usage(rail, [use]))).toBe("src/shell/NavRail.tsx:8");
    const before = FILES["src/shell/NavRail.tsx"]!;
    writeFileSync(join(root, "src/shell/NavRail.tsx"), before.replace(/\n {6}<RailButton label="Connect your agent" \/>|\n {6}<RailButton label="Keyboard shortcuts" \/>/g, "\n      <span />"));
    try {
      expect(show(await run.usage(rail, [use]))).toBe("src/shell/NavRail.tsx:8");
      expect(await new WrapperIndex(sources).usage(rail, [use])).toBeNull();
    } finally {
      writeFileSync(join(root, "src/shell/NavRail.tsx"), before);
    }
  });
});
