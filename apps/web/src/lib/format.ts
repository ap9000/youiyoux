/** A commit as the hub prints it: its first seven characters. */
export const shortSha = (commit: string): string => commit.slice(0, 7);

/** `value` as a percentage of `of`, for a CSS length: a box placed as a share of the page it was measured on. */
export const pct = (value: number, of: number): string => `${(value / of) * 100}%`;
