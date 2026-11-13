/**
 * Where a popup's button is used (behaviour results' file:line): when the line that renders it is
 * inside a component the code uses in more than one place, the next owner frame, if it is one of that
 * component's uses, read from the source with the scanner's parser and module graph. Never from the
 * page's other triggers; anything uncertain keeps the line that renders the button.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { labelsInPage } from "../src/behaviour/in-page.ts";
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
  // Solo is used once here; links (below) would add uses if they were read.
  "src/solo/Solo.tsx": `export function Solo() {
  return <button aria-haspopup="menu" />;
}
export function UsesSolo() {
  return <Solo />;
}
`,
  // W wrapped by a library's higher-order component, used twice: the library's frame sits between.
  "src/hoc/Hoc.tsx": `import { externalHoc } from "some-lib";
export const W = externalHoc(() => <button aria-haspopup="menu" />);
export function UsesW() {
  return (
    <div>
      <W />
      <W />
    </div>
  );
}
`,
  // Two declarations on one line, and two invocations on one line: A is used twice, B once.
  "src/adj/Adj.tsx": `function A() { return <button aria-haspopup="menu" />; } function B() { return <button aria-haspopup="dialog" />; }
export function Uses() { return <div><A /><B /></div>; }
export function UsesA() { return <A />; }
`,
  // W used once for real; the other <W /> names a parameter, and <V /> a local, not the top-level ones.
  "src/shadow/Shadow.tsx": `import { V } from "./V";
export function W() {
  return <button aria-haspopup="menu" />;
}
export function One() {
  return <div><W /><V /></div>;
}
function Other({ W }: { W: () => null }) {
  return <W />;
}
function Third() {
  const V = () => null;
  return <V />;
}
`,
  "src/shadow/V.tsx": `export function V() {
  return <button aria-haspopup="menu" />;
}
`,
  // Q used twice, both through a barrel that doesn't parse cleanly.
  "src/bb/Q.tsx": `export function Q() {
  return <button aria-haspopup="menu" />;
}
`,
  "src/bb/index.ts": `export { Q } from "./Q";
const oops = (;
`,
  "src/bb/UsesQ.tsx": `import { Q } from ".";
export function UsesQ() {
  return (
    <div>
      <Q />
      <Q />
    </div>
  );
}
`,
  // M used twice, once across several lines.
  "src/multi/Multi.tsx": `function M() {
  return <button aria-haspopup="menu" />;
}
export function Ms() {
  return (
    <div>
      <M
        a="1"
      />
      <M />
    </div>
  );
}
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
// Links: one to a file outside the root that uses Solo, one to a file inside the root that uses Solo.
const SOLO_USE = 'import { Solo } from "../solo/Solo";\nexport function Linked() {\n  return <Solo />;\n}\n';
writeFileSync(join(scratch, "outside/UsesSolo.tsx"), SOLO_USE);
mkdirSync(join(root, "src/link"), { recursive: true });
symlinkSync(join(scratch, "outside/UsesSolo.tsx"), join(root, "src/link/Out.tsx"));
mkdirSync(join(root, "src/real"), { recursive: true });
writeFileSync(join(root, "src/real/In.tsx"), "export const nothing = null;\n");
writeFileSync(join(root, "src/link-target.txt"), SOLO_USE);
symlinkSync(join(root, "src/link-target.txt"), join(root, "src/link/In.tsx"));
/** Every file the index opens. */
const reads: string[] = [];
const sources = { root, include: ["src/**/*.{ts,tsx}"], exclude: [], tsconfig: "tsconfig.json", readFile: async (path: string) => (reads.push(path), readFile(path, "utf8")) };
/** Where `needle` is in `file` (the nth match), as a frame: line and column. */
const at = (file: string, needle: string, nth = 0): PlaceLine => {
  const found = FILES[file]!.split("\n").flatMap((text, i) => {
    const out: PlaceLine[] = [];
    for (let column = text.indexOf(needle); column >= 0; column = text.indexOf(needle, column + 1)) out.push({ file, line: i + 1, column: column + 1 });
    return out;
  })[nth];
  if (!found) throw new Error(`no ${needle} in ${file}`);
  return found;
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
    const MAP: readonly PlaceLine[] = [at("src/list/Row.tsx", "<button"), at("src/list/List.tsx", "<Row"), at("src/list/Dashboard.tsx", "<List", 0), at("src/list/Dashboard.tsx", "<List", 1)];
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
    const files = [...new Set(MAP.map((p) => p.file))];
    let previous = { source: 0, line: 0, column: 0 };
    const mappings = MAP.map(({ file, line, column }) => {
      const source = files.indexOf(file);
      const segment = vlq(0) + vlq(source - previous.source) + vlq(line - 1 - previous.line) + vlq(column - 1 - previous.column);
      previous = { source, line: line - 1, column: column - 1 };
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
    // A frame without a column, first or next.
    expect(await index.usage({ ...rail, column: 0 }, [at("src/shell/NavRail.tsx", 'label="Search"')])).toBeNull();
    expect(await index.usage(rail, [{ ...at("src/shell/NavRail.tsx", 'label="Search"'), column: 0 }])).toBeNull();
    const m = at("src/multi/Multi.tsx", "<button");
    expect(show(await index.usage(m, [at("src/multi/Multi.tsx", 'a="1"')]))).toBe("src/multi/Multi.tsx:8");
    expect(await index.usage(m, [{ ...at("src/multi/Multi.tsx", 'a="1"'), column: 0 }])).toBeNull();
  });

  test("nothing outside the root is opened, and a linked file adds no uses (outside the root or inside it)", async () => {
    reads.length = 0;
    const run = new WrapperIndex(sources);
    expect(await run.usage(at("src/far/Far.tsx", "<button"), [at("src/far/UsesFar.tsx", "<Far")])).toBeNull();
    const real = realpathSync(root);
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.filter((path) => !path.startsWith(`${real}/`))).toEqual([]);
    expect(reads.filter((path) => path.includes("/link/") || path.endsWith("link-target.txt"))).toEqual([]);
    // Solo has one use of its own; the two links would make three.
    expect(await run.usage(at("src/solo/Solo.tsx", "<button"), [at("src/solo/Solo.tsx", "<Solo")])).toBeNull();
  });

  test("a frame that couldn't be placed between the button and a use (a library's higher-order component) is never crossed", async () => {
    const button = at("src/hoc/Hoc.tsx", "<button");
    const use = at("src/hoc/Hoc.tsx", "<W", 1);
    // With the library's frame known to be there, the line stays where the button is written.
    expect(await index.usage(button, [{ file: "", line: 0, column: 0, uncertain: true }, use])).toBeNull();
    // (Without it, W's second use would be taken: what the boundary stops.)
    expect(show(await index.usage(button, [use]))).toBe("src/hoc/Hoc.tsx:7");
    // The page marks the gap: an owner whose frames are all a library's, or a library's frame after the app's.
    const stack = (...frames: string[]) => ({ stack: ["Error: react-stack-top-frame", "    at exports.jsxDEV (http://x/node_modules/.vite/deps/react_jsx-dev-runtime.js:1:1)", ...frames.map((f) => `    at ${f}`), "    at react-stack-bottom-frame (http://x/node_modules/.vite/deps/react-dom.js:9:9)"].join("\n") });
    const fiber = (debug: { stack: string }, owner: unknown) => ({ tag: 0, type: function Inner() {}, return: null, _debugStack: debug, _debugOwner: owner });
    const app = fiber(stack("UsesW (http://x/src/hoc/Hoc.tsx:7:7)"), null);
    const hoc = fiber(stack("render (http://x/node_modules/.vite/deps/some-lib.js:5:5)"), app);
    const host = { ...fiber(stack("anonymous (http://x/src/hoc/Hoc.tsx:2:36)"), hoc), tag: 5, type: "button" };
    const element = { "__reactFiber$x": host };
    const gap = { url: "", line: 0, column: 0 };
    expect(labelsInPage.call(element as unknown as Element, { component: null, maxFrames: 6 }).frames).toEqual([{ url: "http://x/src/hoc/Hoc.tsx", line: 2, column: 36 }, gap, { url: "http://x/src/hoc/Hoc.tsx", line: 7, column: 7 }]);
    const direct = { ...fiber(stack("anonymous (http://x/src/hoc/Hoc.tsx:2:36)"), app), tag: 5, type: "button" };
    expect(labelsInPage.call({ "__reactFiber$x": direct } as unknown as Element, { component: null, maxFrames: 6 }).frames).toEqual([{ url: "http://x/src/hoc/Hoc.tsx", line: 2, column: 36 }, { url: "http://x/src/hoc/Hoc.tsx", line: 7, column: 7 }]);
    // Library code called by the app's frame, inside one owner's stack, is a gap too.
    const called = { ...fiber(stack("cb (http://x/src/hoc/Hoc.tsx:2:36)", "Lib (http://x/node_modules/.vite/deps/some-lib.js:3:3)"), app), tag: 5, type: "button" };
    expect(labelsInPage.call({ "__reactFiber$x": called } as unknown as Element, { component: null, maxFrames: 6 }).frames).toEqual([{ url: "http://x/src/hoc/Hoc.tsx", line: 2, column: 36 }, gap, { url: "http://x/src/hoc/Hoc.tsx", line: 7, column: 7 }]);
  });

  test("by position, not line: adjacent declarations on one line, and two elements on one line", async () => {
    const a = at("src/adj/Adj.tsx", "<button", 0);
    const b = at("src/adj/Adj.tsx", "<button", 1);
    // B's button is in B (used once), not A (used twice), though they share line 1.
    expect(await index.usage(b, [at("src/adj/Adj.tsx", "<B")])).toBeNull();
    // Even handed one of A's uses, B's button is B's: never A's two uses.
    expect(await index.usage(b, [at("src/adj/Adj.tsx", "<A", 0)])).toBeNull();
    // A's next frame inside <A /> on line 2 is taken; one inside <B /> on the same line is not A's use.
    expect(show(await index.usage(a, [at("src/adj/Adj.tsx", "<A", 0)]))).toBe("src/adj/Adj.tsx:2");
    expect(await index.usage(a, [at("src/adj/Adj.tsx", "<B")])).toBeNull();
  });

  test("a JSX name bound inside the statement around it (a parameter, a local) isn't a use of the top-level one", async () => {
    expect(await index.usage(at("src/shadow/Shadow.tsx", "<button"), [at("src/shadow/Shadow.tsx", "<W", 0)])).toBeNull();
    expect(await index.usage(at("src/shadow/V.tsx", "<button"), [at("src/shadow/Shadow.tsx", "<V", 0)])).toBeNull();
  });

  test("a use reached through a module that doesn't parse cleanly (a broken barrel) isn't counted", async () => {
    expect(await index.usage(at("src/bb/Q.tsx", "<button"), [at("src/bb/UsesQ.tsx", "<Q", 1)])).toBeNull();
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
