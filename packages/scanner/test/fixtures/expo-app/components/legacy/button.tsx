export function Button(p: { kind?: string; children?: unknown }) { return <button className="legacy">{p.children as never}</button>; }
