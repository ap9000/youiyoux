export function Card(p: { children?: unknown }) { return <section>{p.children as never}</section>; }
export function CardHeader(p: { children?: unknown }) { return <div>{p.children as never}</div>; }
