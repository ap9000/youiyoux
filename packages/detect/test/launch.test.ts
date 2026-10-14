import { existsSync } from "node:fs";
import type { Browser, LaunchOptions } from "playwright-core";
import { describe, expect, test } from "vitest";
import { BrowserMissingError, DOWNLOAD_NOTICE, launchBrowser, playwrightCli } from "../src/site.ts";

const MISSING = new Error("browserType.launch: Executable doesn't exist at /cache/chromium_headless_shell-1248/chrome-headless-shell");
const BROWSER = { fake: true } as unknown as Browser;

/** launchBrowser with fakes: `outcomes` are what each launch does, in order. */
function fakes(outcomes: readonly (Error | Browser)[], exitCode = 0) {
  const launches: LaunchOptions[] = [];
  const spawns: { command: string; args: readonly string[] }[] = [];
  const logs: string[] = [];
  const deps = {
    launch: async (options: LaunchOptions) => {
      const outcome = outcomes[launches.push(options) - 1];
      if (!outcome || outcome instanceof Error) throw outcome ?? new Error("unexpected launch");
      return outcome;
    },
    spawn: async (command: string, args: readonly string[]) => (spawns.push({ command, args }), exitCode),
    log: (line: string) => void logs.push(line),
  };
  return { deps, launches, spawns, logs };
}

describe("launchBrowser downloads the headless shell lazily", () => {
  test("playwright-core's cli.js is where launchBrowser looks for it", () => {
    expect(playwrightCli()).toMatch(/playwright-core[/\\]cli\.js$/);
    expect(existsSync(playwrightCli())).toBe(true);
  });

  test("an installed browser launches with no download", async () => {
    const f = fakes([BROWSER]);
    expect(await launchBrowser(undefined, f.deps)).toBe(BROWSER);
    expect(f.launches).toEqual([{ headless: true }]);
    expect(f.spawns).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  test("a missing browser: one notice, cli.js install run by this Node, one retry", async () => {
    const f = fakes([MISSING, BROWSER]);
    expect(await launchBrowser(undefined, f.deps)).toBe(BROWSER);
    expect(f.logs).toEqual(["youiyoux detect: downloading Chromium headless shell (~100 MB, once)"]);
    expect(DOWNLOAD_NOTICE).toBe(f.logs[0]);
    expect(f.spawns).toEqual([{ command: process.execPath, args: [playwrightCli(), "install", "chromium-headless-shell"] }]);
    expect(f.launches).toHaveLength(2);
  });

  test("still missing after the download: BrowserMissingError, no second download", async () => {
    const f = fakes([MISSING, MISSING, BROWSER], 1);
    const failed = launchBrowser(undefined, f.deps);
    await expect(failed).rejects.toThrowError(BrowserMissingError);
    await expect(failed).rejects.toThrowError(/installer exit code 1/);
    expect(f.launches).toHaveLength(2);
    expect(f.spawns).toHaveLength(1);
  });

  test("an explicit executablePath is never downloaded over", async () => {
    const f = fakes([MISSING]);
    await expect(launchBrowser("/opt/no-chromium", f.deps)).rejects.toThrowError(/at \/opt\/no-chromium \(YOUI_CHROMIUM\)/);
    expect(f.launches).toEqual([{ headless: true, executablePath: "/opt/no-chromium" }]);
    expect(f.spawns).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  test("website detection's messages stay word for word", async () => {
    const f = fakes([MISSING, MISSING], 1);
    await expect(launchBrowser(undefined, f.deps)).rejects.toThrowError("no Chromium for website detection: downloading the headless shell failed (installer exit code 1); check the network and run youiyoux detect again, or set YOUI_CHROMIUM to a Chromium");
    await expect(launchBrowser("/opt/no-chromium", fakes([MISSING]).deps)).rejects.toThrowError("no Chromium for website detection at /opt/no-chromium (YOUI_CHROMIUM): point it at a Chromium, or unset it to use the headless shell youiyoux detect downloads");
  });

  test("another purpose names itself in the notice and the errors", async () => {
    const f = fakes([MISSING, BROWSER]);
    const purpose = { what: "youiyoux render", command: "youiyoux render" };
    expect(await launchBrowser(undefined, { ...f.deps, purpose })).toBe(BROWSER);
    expect(f.logs).toEqual(["youiyoux render: downloading Chromium headless shell (~100 MB, once)"]);
    await expect(launchBrowser("/opt/no-chromium", { ...fakes([MISSING]).deps, purpose })).rejects.toThrowError(/^no Chromium for youiyoux render at \/opt\/no-chromium \(YOUI_CHROMIUM\).*the headless shell youiyoux render downloads$/);
  });

  test("download: false never downloads: a missing shell is an error with the install command", async () => {
    const f = fakes([MISSING, BROWSER]);
    const failed = launchBrowser(undefined, { ...f.deps, download: false, purpose: { what: "youiyoux render", command: "youiyoux render" } });
    await expect(failed).rejects.toThrowError(BrowserMissingError);
    await expect(failed).rejects.toThrowError(/^no Chromium for youiyoux render: the headless shell is not installed; run node .*cli\.js install chromium-headless-shell, or set YOUI_CHROMIUM to a Chromium$/);
    expect(f.spawns).toEqual([]);
    expect(f.logs).toEqual([]);
    expect(f.launches).toHaveLength(1);
  });

  test("other launch failures pass through untouched", async () => {
    const crash = new Error("Target page, context or browser has been closed");
    const f = fakes([crash]);
    await expect(launchBrowser(undefined, f.deps)).rejects.toBe(crash);
    expect(f.spawns).toEqual([]);
  });
});
