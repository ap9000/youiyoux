/**
 * The app fingerprint behind every behaviour result's freshness: what it covers, and that it says
 * when it can't cover the whole app (then nothing can be fresh against it). Temp folders only.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { appFingerprint } from "../src/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "youi-fingerprint-"));
afterAll(() => {
  for (const dir of [join(scratch, "locked", "secret")]) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* not there */
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** An app folder outside any git repository (the walk is used), with a source file and package.json. */
function app(name: string): { root: string; project: Parameters<typeof appFingerprint>[0] } {
  const root = join(scratch, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/app.tsx"), "export const App = () => null;\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, dependencies: { react: "19.0.0" } }));
  return { root, project: { root, config: { include: ["src/**/*.tsx"], exclude: [] } } as unknown as Parameters<typeof appFingerprint>[0] };
}

describe("the app fingerprint", () => {
  test("a walk that reaches its cap, or a folder it can't read, makes the fingerprint incomplete, with why", async () => {
    const capped = app("capped");
    for (const n of [1, 2, 3]) writeFileSync(join(capped.root, `extra-${n}.txt`), String(n));
    expect((await appFingerprint(capped.project)).incomplete).toBeNull();
    expect((await appFingerprint(capped.project, { maxWalked: 2 })).incomplete).toBe("the app has more than 2 files outside git; add it to git or list what it reads under behaviour.inputs");
    const locked = app("locked");
    mkdirSync(join(locked.root, "secret"));
    writeFileSync(join(locked.root, "secret/config.js"), "x");
    chmodSync(join(locked.root, "secret"), 0o000);
    try {
      expect((await appFingerprint(locked.project)).incomplete).toMatch(/the folder secret couldn't be read/);
    } finally {
      chmodSync(join(locked.root, "secret"), 0o755);
    }
  });

  test("a behaviour.inputs link is followed to its content inside the project; one leading outside makes it incomplete", async () => {
    const a = app("inputs");
    writeFileSync(join(a.root, ".env.real"), "FLAG=on\n");
    symlinkSync(".env.real", join(a.root, ".env.development"));
    const before = await appFingerprint(a.project, { inputs: [".env.development"] });
    expect(before.incomplete).toBeNull();
    writeFileSync(join(a.root, ".env.real"), "FLAG=off\n");
    // The link's text didn't change; what it points at did.
    const after = await appFingerprint(a.project, { inputs: [".env.development"] });
    expect(after.digest).not.toBe(before.digest);
    const outside = join(scratch, "outside.env");
    writeFileSync(outside, "SECRET=1\n");
    symlinkSync(outside, join(a.root, ".env.local"));
    expect((await appFingerprint(a.project, { inputs: [".env.local"] })).incomplete).toBe("behaviour.inputs names .env.local, which leads outside the project");
  });

  test("the package managers' install state counts (transitive versions); a hand edit inside node_modules is a residual it doesn't see", async () => {
    const a = app("installs");
    mkdirSync(join(a.root, "node_modules/.pnpm"), { recursive: true });
    mkdirSync(join(a.root, "node_modules/react"), { recursive: true });
    writeFileSync(join(a.root, "node_modules/react/package.json"), JSON.stringify({ name: "react", version: "19.0.0" }));
    writeFileSync(join(a.root, "node_modules/react/index.js"), "module.exports = 1;\n");
    const digest = async () => (await appFingerprint(a.project)).digest;
    let was = await digest();
    for (const file of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.package-lock.json", "node_modules/.yarn-state.yml"]) {
      writeFileSync(join(a.root, file), `${file}: scheduler@0.25.0\n`);
      const now = await digest();
      expect(now, file).not.toBe(was);
      was = now;
    }
    mkdirSync(join(a.root, ".yarn"), { recursive: true });
    writeFileSync(join(a.root, ".yarn/install-state.gz"), "state");
    expect(await digest()).not.toBe(was);
    was = await digest();
    // Residual (documented): code edited by hand inside an installed package.
    writeFileSync(join(a.root, "node_modules/react/index.js"), "module.exports = 2;\n");
    expect(await digest()).toBe(was);
  });
});
