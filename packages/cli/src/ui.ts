/**
 * Terminal styling: monochrome by default, colour only for
 * status (red fails, amber warns, green passes, blue is live), dim for facts
 * a machine produced. Colour is off when stdout is not a TTY or NO_COLOR is set.
 */
import { styleText } from "node:util";

type Format = Parameters<typeof styleText>[0];

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (format: Format) => (text: string | number): string => (enabled ? styleText(format, String(text), { validateStream: false }) : String(text));

export const style = {
  bold: paint("bold"),
  dim: paint("dim"),
  error: paint("red"),
  warn: paint("yellow"),
  ok: paint("green"),
  live: paint("blue"),
  accent: paint(["bold", "white"]),
};

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleLength(text))) + text;
}

export function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** A quiet proportional bar: █ for the share, nothing for the rest. */
export function bar(value: number, max: number, width = 24): string {
  const cells = max === 0 ? 0 : Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width));
  return style.dim("█".repeat(cells));
}

export function rule(width = 64): string {
  return style.dim("─".repeat(width));
}

export function ms(value: number): string {
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}
