/**
 * A signed-in session for `youiyoux screens capture`, recorded once by `youiyoux screens login`:
 * a browser window opens at the app, a person signs in there, and the browser's cookies and
 * storage are kept as a Playwright storage state, which capture then uses when no
 * `--storage-state` is named. It holds a sign-in, so it is never written in the product (where git
 * could pick it up): it goes under `$XDG_CACHE_HOME/youiyoux/sessions` (`~/.cache`), named by the
 * product's root, readable by its owner only. Deleting the file signs capture out.
 */
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { sha256 } from "@youiyoux/core";

export type { Browser as LoginBrowser, Page as LoginPage };

/** Where a product's session is kept: its folder's name, made safe, and a hash of its real path. */
export function sessionFile(root: string, env: NodeJS.ProcessEnv = process.env): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {}
  const name = basename(real).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "product";
  const hash = sha256(real).slice(0, 12);
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "youiyoux", "sessions", `${name}-${hash}.json`);
}

/** The session capture should use: the one named, else the one `screens login` saved for this root, else none. */
export function chosenSession(root: string, named: string | undefined, env: NodeJS.ProcessEnv = process.env): { file: string; saved: boolean } | null {
  if (named) return { file: named, saved: false };
  const file = sessionFile(root, env);
  return existsSync(file) ? { file, saved: true } : null;
}

/** Written whole or not at all, owner-only from the first byte. */
async function writePrivate(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export interface LoginOptions {
  /** Where the app runs (`http://localhost:3000`). */
  readonly base: string;
  /** Where the session goes (sessionFile, unless one is named). */
  readonly file: string;
  /** A browser a person can see and use. */
  readonly browser: Browser;
  /** Resolves true once the person says they are signed in, false if they gave up. */
  readonly signedIn: (page: Page) => Promise<boolean>;
}

export interface LoginResult {
  /** Null when nothing was saved: the person gave up, or closed the window first. */
  readonly file: string | null;
  readonly cookies: number;
  readonly origins: number;
}

/** A browser window a person can see: YOUI_CHROMIUM's, else the installed Google Chrome (the headless shell has no window). */
export function openLoginBrowser(executablePath?: string): Promise<Browser> {
  return chromium.launch({ headless: false, ...(executablePath ? { executablePath } : { channel: "chrome" }) });
}

/** Open the app, wait for the person, and keep what the browser holds then. */
export async function recordSession(options: LoginOptions): Promise<LoginResult> {
  const context = await options.browser.newContext({ viewport: null });
  try {
    const page = await context.newPage();
    let closed = false;
    page.on("close", () => (closed = true));
    await page.goto(options.base, { waitUntil: "domcontentloaded" });
    const done = await options.signedIn(page);
    if (!done || closed) return { file: null, cookies: 0, origins: 0 };
    const state = await context.storageState();
    await writePrivate(options.file, `${JSON.stringify(state, null, 2)}\n`);
    return { file: options.file, cookies: state.cookies.length, origins: state.origins.length };
  } finally {
    await context.close().catch(() => undefined);
  }
}
