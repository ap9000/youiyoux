/** Add `value` to the list `map` holds under `key`, starting the list when there is none. */
export function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
