/**
 * Does `youi where button` match reality? An independent cross-check that
 * shares no code with the scanner: plain regular expressions over import lines
 * and `<Tag` occurrences, file by file, compared with the scanner's counts.
 *
 *   node pilot/toolroll/verify-where.ts /path/to/toolroll-copy
 */
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadProject, scanProject } from "@youiyoux/scanner";

const root = process.argv[2];
if (!root) {
  process.stderr.write("usage: node pilot/toolroll/verify-where.ts <toolroll-copy>\n");
  process.exit(2);
}
const config = resolve(import.meta.dirname, "youi.project.json");

/** Local names bound to Button, by where the import points (owned components dir vs anything else). */
function buttonBindings(source: string): { owned: string[]; other: string[] } {
  const owned: string[] = [];
  const other: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const from = match[2]!;
    for (const spec of match[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [imported, local = imported] = spec.split(/\s+as\s+/).map((s) => s.trim()) as [string, string?];
      if (imported !== "Button") continue;
      (from.includes("components/ui") ? owned : other).push(local!);
    }
  }
  return { owned, other };
}

const count = (source: string, name: string): number => [...source.matchAll(new RegExp(`<${name}(?=[\\s>/])`, "g"))].length;

const independent = new Map<string, { owned: number; other: number }>();
for await (const file of glob("src/browser/**/*.tsx", { cwd: root })) {
  if (file.includes(".test.") || file.includes("components/ui/")) continue;
  const source = await readFile(join(root, file), "utf8");
  const { owned, other } = buttonBindings(source);
  const tally = { owned: owned.reduce((n, name) => n + count(source, name), 0), other: other.reduce((n, name) => n + count(source, name), 0) };
  if (tally.owned + tally.other > 0) independent.set(file, tally);
}

const project = await loadProject(root, { configPath: config });
const { report } = await scanProject(project);
const scanner = new Map<string, { owned: number; other: number }>();
for (const u of report.usages) if (u.element === "youi:signal/component/button" && u.kind === "render" && u.export === "Button") scanner.set(u.file, { owned: (scanner.get(u.file)?.owned ?? 0) + 1, other: scanner.get(u.file)?.other ?? 0 });
for (const l of report.lookalikes) if (l.resembles === "youi:signal/component/button") scanner.set(l.file, { owned: scanner.get(l.file)?.owned ?? 0, other: (scanner.get(l.file)?.other ?? 0) + 1 });

const files = [...new Set([...independent.keys(), ...scanner.keys()])].sort();
let mismatches = 0;
const rows = files.map((file) => {
  const a = independent.get(file) ?? { owned: 0, other: 0 };
  const b = scanner.get(file) ?? { owned: 0, other: 0 };
  const same = a.owned === b.owned && a.other === b.other;
  if (!same) mismatches++;
  return `${same ? "✓" : "✖"} ${file.padEnd(42)} owned ${String(a.owned).padStart(3)} / ${String(b.owned).padStart(3)}   lookalike ${String(a.other).padStart(3)} / ${String(b.other).padStart(3)}`;
});
const sum = (m: Map<string, { owned: number; other: number }>, k: "owned" | "other"): number => [...m.values()].reduce((n, v) => n + v[k], 0);
process.stdout.write(`${rows.join("\n")}\n\nindependent / scanner: owned Button ${sum(independent, "owned")} / ${sum(scanner, "owned")}, lookalike Button ${sum(independent, "other")} / ${sum(scanner, "other")}; ${mismatches === 0 ? "every file matches" : `${mismatches} file(s) differ`}\n`);
process.exitCode = mismatches === 0 ? 0 : 1;
