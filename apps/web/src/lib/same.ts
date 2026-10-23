/** Two plain-data values are the same when they serialise the same (drafts and their edits). */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
