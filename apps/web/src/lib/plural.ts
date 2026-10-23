/** The noun for a count written beside it (in a `<Num>`, say): `file` or `files`. */
export const noun = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** A count and its noun: `1 file`, `3 files`. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${noun(n, one, many)}`;
