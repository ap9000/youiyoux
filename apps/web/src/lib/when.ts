/** A moment as the hub writes it beside a request or a picture: `Oct 22, 11:34 AM`, in the reader's locale. */
export const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
