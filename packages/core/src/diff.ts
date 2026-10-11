/**
 * A small unified diff for reviewable patches. Common prefix and suffix are
 * trimmed first, so the LCS table only covers the changed middle (codemod
 * edits are local, which keeps this cheap on large files).
 */

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

function lcsOps(a: readonly string[], b: readonly string[], aStart: number, bStart: number): Op[] {
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = a[i] === b[j] ? table[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ kind: " ", line: a[i]!, a: aStart + i++, b: bStart + j++ });
    else if (i < n && (j === m || table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!)) ops.push({ kind: "-", line: a[i]!, a: aStart + i++, b: bStart + j });
    else ops.push({ kind: "+", line: b[j]!, a: aStart + i, b: bStart + j++ });
  }
  return ops;
}

export function unifiedDiff(file: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const ops: Op[] = [
    ...a.slice(0, prefix).map((line, k) => ({ kind: " " as const, line, a: k, b: k })),
    ...lcsOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), prefix, prefix),
    ...a.slice(a.length - suffix).map((line, k) => ({ kind: " " as const, line, a: a.length - suffix + k, b: b.length - suffix + k })),
  ];
  const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
  const hunks: string[] = [];
  let cursor = 0;
  while (cursor < changed.length) {
    const start = Math.max(0, changed[cursor]! - context);
    let end = changed[cursor]!;
    while (cursor < changed.length && changed[cursor]! <= end + 2 * context) end = changed[cursor++]!;
    const slice = ops.slice(start, Math.min(ops.length, end + context + 1));
    const aCount = slice.filter((op) => op.kind !== "+").length;
    const bCount = slice.filter((op) => op.kind !== "-").length;
    hunks.push(`@@ -${slice[0]!.a + 1},${aCount} +${slice[0]!.b + 1},${bCount} @@\n${slice.map((op) => `${op.kind}${op.line}`).join("\n")}`);
  }
  return `--- a/${file}\n+++ b/${file}\n${hunks.join("\n")}\n`;
}
