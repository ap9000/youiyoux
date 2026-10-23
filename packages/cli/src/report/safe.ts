/**
 * Safe to share by default. Every string in the report model passes through `text()` before a
 * writer sees it, and every written output (HTML, Markdown, the card's text) through `scrub()`
 * last, which redacts again and then fails closed: if anything sensitive is still there, nothing
 * is written.
 *
 * Redacted: paths inside the repo become repo-relative; any other absolute path, the home
 * directory and the username (as a path segment or a word) go; so do values from the repo's
 * `.env*` files and from the environment (6 characters or more, apart from well-known settings
 * such as TERM or npm's own and short plain words), `user:password@` in URLs, and in code lines (only with
 * --include-code) strings that look like keys or tokens. Without --include-code the model holds
 * no code at all.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { findFiles } from "@youiyoux/core";

import { publicLook } from "./filters.ts";

const REDACTED = "[redacted]";
const OUTSIDE = "[path outside the repo]";
const MIN_VALUE = 6;

/** Settings, not secrets: their values are ordinary words (a terminal's name, npm's own config) that would only blank out the report's text. */
const BENIGN_ENV = /^(?:npm_|NPM_|PNPM_|NODE_|NVM_|TERM|COLORTERM|LANG$|LANGUAGE$|LC_|SHELL$|SHLVL$|PWD$|OLDPWD$|_$|PATH$|MANPATH$|INFOPATH$|TMPDIR$|TMP$|TEMP$|EDITOR$|VISUAL$|PAGER$|LESS|LOGNAME$|USER$|USERNAME$|HOME$|XPC_|__CF|COMMAND_MODE$|DISPLAY$|HOSTTYPE$|OSTYPE$|MACHTYPE$|INIT_CWD$|FORCE_COLOR$|NO_COLOR$|CI$|COREPACK_|VSCODE_|ITERM_|TERM_|SECURITYSESSIONID$|LaunchInstanceID$|XDG_|HOMEBREW_|SSH_AUTH_SOCK$|STARSHIP_|ZSH|OMZ|P9K|POWERLEVEL|VITEST|TEST$|MODE$|DEV$|PROD$|SSR$|BASE_URL$)/;
const PLAIN_WORD = /^[A-Za-z]+$/;
const PLAIN = /^(?:true|false|yes|no|on|off|null|undefined|\d+(?:\.\d+)?)$/i;

interface SafetyOptions {
  /** The repo root: paths inside it become relative. */
  readonly root: string;
  readonly includeCode?: boolean;
  readonly home?: string;
  readonly username?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Values from the repo's .env files (see `dotenvValues`). */
  readonly dotenv?: readonly string[];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Values in the repo's `.env`, `.env.local`, `apps/web/.env.production` … (never node_modules). */
async function dotenvValues(root: string): Promise<string[]> {
  const files = await findFiles(root, [".env", ".env.*", "**/.env", "**/.env.*"]).catch(() => []);
  const values: string[] = [];
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[1]!.trim().replace(/^(['"`])(.*)\1$/, "$2").replace(/\s+#.*$/, "");
      if (value.length >= MIN_VALUE) values.push(value);
    }
  }
  return values;
}

/** A string that looks like a key or token: a known prefix, or long and random. */
function looksSecret(text: string): boolean {
  if (/^(?:sk|pk|rk)_(?:live|test)_|^sk-[A-Za-z0-9]|^gh[pousr]_|^github_pat_|^xox[abposr]-|^AKIA[0-9A-Z]{12}|^AIza[0-9A-Za-z_-]{20}|^glpat-|^eyJ[A-Za-z0-9_-]{10,}\./.test(text)) return true;
  if (text.length < 20 || /[\s:[\]]/.test(text)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((c) => c.test(text)).length;
  if (classes < 2 || !/\d/.test(text)) return false;
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  const entropy = [...counts.values()].reduce((sum, n) => sum - (n / text.length) * Math.log2(n / text.length), 0);
  return entropy >= 3.5;
}

/**
 * Paths inside the repo made relative (`<root>/src/a.ts` → `src/a.ts`, the root itself → `.`), the
 * root matched only as a whole path: a sibling such as `<root>-design` is a path outside the repo.
 */
function withoutRoot(text: string, root: string): string {
  const at = escapeRegExp(root);
  return text.replace(new RegExp(`${at}/`, "g"), "").replace(new RegExp(`${at}(?![\\w.-])`, "g"), ".");
}

export class Redactor {
  private readonly roots: string[];
  private readonly home: string;
  private readonly username: string;
  private readonly values: string[];
  readonly includeCode: boolean;

  constructor(options: SafetyOptions) {
    const real = (path: string): string => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    this.roots = [...new Set([options.root, real(options.root)])].sort((a, b) => b.length - a.length);
    this.home = options.home ?? homedir();
    this.username = options.username ?? (() => {
      try {
        return userInfo().username;
      } catch {
        return "";
      }
    })();
    // A short plain word ("medium", "production") is a setting, not a secret, and blanking it would blank the report's own words.
    const env = Object.entries(options.env ?? process.env).flatMap(([name, value]) => (value && !BENIGN_ENV.test(name) && !PLAIN.test(value.trim()) && !(PLAIN_WORD.test(value) && value.length < 12) ? [value] : []));
    // Longest first, so a value inside another is not left half-redacted.
    this.values = [...new Set([...env, ...(options.dotenv ?? [])].filter((v) => v.length >= MIN_VALUE && !this.isRoot(v)))].sort((a, b) => b.length - a.length);
    this.includeCode = options.includeCode === true;
  }

  static async forRepo(root: string, options: Omit<SafetyOptions, "root" | "dotenv"> = {}): Promise<Redactor> {
    return new Redactor({ ...options, root, dotenv: await dotenvValues(root) });
  }

  private isRoot(value: string): boolean {
    return this.roots.some((root) => value === root || root.startsWith(`${value}/`));
  }

  /** One string, cleaned. */
  text(input: string): string {
    let text = input;
    for (const root of this.roots) text = withoutRoot(text, root);
    text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+(?::[^\s/@"'<>]*)?@/gi, `$1${REDACTED}@`);
    for (const value of this.values) text = text.split(value).join(REDACTED);
    text = text.replace(/(^|[\s"'`(=,:;])(?:~\/|\/(?:Users|home|root|var|private|tmp|opt|mnt|media|Volumes|srv|etc|usr|workspace|workspaces|builds|runner|github|nix)\b)[^\s"'`<>)]*/g, `$1${OUTSIDE}`);
    text = text.replace(/(^|[\s"'`(=,:;])[A-Za-z]:\\[^\s"'`<>)]*/g, `$1${OUTSIDE}`);
    if (this.home.length > 1) text = text.split(this.home).join("~");
    if (this.username.length >= 3) text = text.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(this.username)}(?![A-Za-z0-9])`, "g"), REDACTED);
    return text;
  }

  /** A line of code (--include-code): cleaned, and strings that look like keys or tokens blanked. */
  code(input: string): string {
    const assigned = /((?:key|token|secret|passw(?:or)?d|pwd|auth|credential|session|cookie|private|dsn|api[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["'`])([^"'`]{4,})\2/gi;
    const text = input.replace(assigned, `$1$2${REDACTED}$2`).replace(/(["'`])([^"'`\s]{12,})\1/g, (whole, quote: string, inner: string) => (looksSecret(inner) ? `${quote}${REDACTED}${quote}` : whole)).replace(/[A-Za-z0-9_\-+/=.]{20,}/g, (token) => (looksSecret(token) ? REDACTED : token));
    return this.text(text);
  }

  /** The whole model, every string cleaned; code only when it was asked for. */
  model<T>(value: T): T {
    const walk = (node: unknown, key: string | null): unknown => {
      if (typeof node === "string") return key === "code" ? this.code(node) : this.text(node);
      if (Array.isArray(node)) return node.map((item) => walk(key === "looks" && !this.includeCode && typeof item === "string" ? publicLook(item) : item, null));
      if (node && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
          if (k === "code" && !this.includeCode) continue;
          // Images are data: URIs drawn from the specimen cache; their bytes are not text.
          out[k] = k === "light" || k === "dark" ? v : walk(v, k);
        }
        return out;
      }
      return node;
    };
    return walk(value, null) as T;
  }

  /** What sensitive text is still in `output`: the names of the kinds found, never the values. */
  leaks(output: string): string[] {
    const found: string[] = [];
    if (this.roots.some((root) => output.includes(root))) found.push("an absolute path to the repo");
    if (this.home.length > 1 && output.includes(this.home)) found.push("the home directory");
    if (this.username.length >= 3 && new RegExp(`[/\\\\~]${escapeRegExp(this.username)}(?![A-Za-z0-9])`).test(output)) found.push("the username in a path");
    if (this.values.some((v) => output.includes(v))) found.push("an environment or .env value");
    if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@/i.test(output)) found.push("a URL with credentials");
    return found;
  }

  /** Last pass over a written output: clean it, then refuse it if anything sensitive survived. */
  scrub(output: string): string {
    let text = output;
    if (this.leaks(text).length === 0) return text;
    for (const root of this.roots) text = withoutRoot(text, root);
    if (this.home.length > 1) text = text.split(this.home).join("~");
    for (const value of this.values) text = text.split(value).join(REDACTED);
    text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]+@/gi, `$1${REDACTED}@`);
    if (this.username.length >= 3) text = text.replace(new RegExp(`([/\\\\~])${escapeRegExp(this.username)}(?![A-Za-z0-9])`, "g"), `$1${REDACTED}`);
    const left = this.leaks(text);
    if (left.length > 0) throw new Error(`the report still held ${left.join(", ")} after redaction, so nothing was written`);
    return text;
  }
}
