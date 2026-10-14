// Node 20 lacks a few things the youi sources use (Node 22+): added here, before anything else runs.
if (!Map.groupBy) {
  Map.groupBy = (items, key) => {
    const groups = new Map();
    let i = 0;
    for (const item of items) {
      const k = key(item, i++);
      const list = groups.get(k);
      if (list) list.push(item);
      else groups.set(k, [item]);
    }
    return groups;
  };
}
if (!Object.groupBy) Object.groupBy = (items, key) => Object.fromEntries(Map.groupBy(items, key));
if (!Promise.withResolvers) {
  Promise.withResolvers = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
    return { promise, resolve, reject };
  };
}
