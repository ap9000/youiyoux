/**
 * Safe to share by default (c3). A fixture built at run time carries planted values, each random
 * per run and placed where the report would otherwise show it: on lines that are findings, and in
 * directory names the report lists. By default none of them reaches the HTML, the Markdown or the
 * card (its bytes and chunks), and every path shown is repo-relative. --include-code adds the lines
 * of code (the planted code line appears), while the secrets, the home path, the username, the
 * environment values and the credentials still do not.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Redactor } from "../src/report/safe.ts";
import { fixtureRepo, GIT_ENV, report, singleFiles, type FixtureRepo } from "./report-fixtures.ts";

const hex = (n: number): string => randomBytes(n).toString("hex");
const planted = {
  secret: `sk_live_${hex(12)}`,
  dotenv: `dotenv${hex(10)}`,
  env: `envval${hex(10)}`,
  token: `ghp${hex(10)}`,
  home: homedir(),
  username: userInfo().username,
  // Distinctive, but not random-looking: a long random string in code is blanked as a likely token.
  code: `marker-${hex(4)}`,
  literalHref: "https://fixture.invalid/register",
  literalText: "Private customer label",
};

let repo: FixtureRepo;
const outputs: Record<"plain" | "code", { html: string; md: string; png: Buffer }> = {} as never;

function privateFiles(): Record<string, string> {
  // Each planted value sits on a line the report lists (a hardcoded colour), and two in directory names.
  const line = (extra: string): string => `      <p className="text-[#dc2626]" data-marker="${planted.code}">${extra}</p>`;
  return singleFiles({
    "src/components/private-link.tsx": `export function PrivateLink() { return <a href="${planted.literalHref}" className="text-[#2563eb]">${planted.literalText}</a>; }`,
    ".env": `STRIPE_SECRET=${planted.dotenv}\nPORT=3000\n`,
    "src/app/private/page.tsx": [
      `const STRIPE_KEY = "${planted.secret}";`,
      "",
      "export default function Private() {",
      "  return (",
      "    <div>",
      line(`{"${planted.secret}"}`),
      line(`{/* ${planted.home}/notes and https://deploy:${planted.token}@git.example.com/acme.git */}`),
      line(`{"${planted.dotenv}"} {"${planted.env}"}`),
      "    </div>",
      "  );",
      "}",
      "",
    ].join("\n"),
    [`src/${planted.username}-kit/badge.tsx`]: `export function Badge() {\n  return <span className="border-[#2563eb]">New</span>;\n}\n`,
    [`src/${planted.env}/promo.tsx`]: `export function Promo() {\n  return <span className="bg-[#dc2626]">Sale</span>;\n}\n`,
  });
}

beforeAll(async () => {
  repo = fixtureRepo("private", privateFiles());
  execFileSync("git", ["remote", "add", "origin", `https://deploy:${planted.token}@git.example.com/acme.git`], { cwd: repo.dir, env: { ...process.env, ...GIT_ENV } });
  const env = { ...process.env, YOUIYOUX_PLANTED_SECRET: planted.env };
  for (const mode of ["plain", "code"] as const) {
    const run = await report(repo.dir, { includeCode: mode === "code" }, { env });
    expect(run.code).toBe(0);
    outputs[mode] = { html: readFileSync(join(repo.dir, "youiyoux-report.html"), "utf8"), md: readFileSync(join(repo.dir, "youiyoux-summary.md"), "utf8"), png: readFileSync(join(repo.dir, "youiyoux-card.png")) };
  }
}, 60_000);
afterAll(() => repo.remove());

const secrets = ["secret", "dotenv", "env", "token", "home", "username"] as const;

function texts(mode: "plain" | "code"): Array<[string, string]> {
  const { html, md, png } = outputs[mode];
  return [["html", html], ["markdown", md], ["png", png.toString("latin1")]];
}

describe("youiyoux report: safe to share", () => {
  test("the planted lines are findings, so the report would show them", () => {
    expect(outputs.code.html).toContain("src/app/private/page.tsx:6");
    expect(outputs.code.html).toContain("-kit/badge.tsx");
  });

  test("by default: no code, secrets, home path, username, environment or .env values, or credentials (c3)", () => {
    for (const [name, text] of texts("plain")) {
      for (const key of [...secrets, "code", "literalHref", "literalText"] as const) expect(text.includes(planted[key]), `${name} holds the planted ${key}`).toBe(false);
      expect(text, name).not.toContain(repo.dir);
      expect(text, name).not.toMatch(/https?:\/\/[^\s/@"<]+:[^\s/@"<]+@/);
    }
    expect(outputs.plain.html).not.toContain("<pre>");
    expect(outputs.plain.html).toContain("[redacted]-kit/badge.tsx");
    expect(outputs.plain.html).toContain("src/[redacted]/promo.tsx");
  });

  test("every path shown is relative to the repo", () => {
    const shown = [...outputs.plain.html.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1]!);
    expect(shown.length).toBeGreaterThan(5);
    for (const path of shown) expect(path).toMatch(/^(?:src|\[redacted\])[^:]*(?::\d+)?$|^\S+\.tsx?:\d+$/);
    for (const path of shown) expect(path.startsWith("/") || path.startsWith("~") || /^[A-Z]:\\/.test(path)).toBe(false);
  });

  test("the card has no text chunks: its only text is drawn", () => {
    const png = outputs.plain.png;
    const chunks: string[] = [];
    for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) chunks.push(png.toString("ascii", at + 4, at + 8));
    expect(chunks).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  test("--include-code adds the lines of code, and still nothing secret", () => {
    for (const [name, text] of texts("code")) {
      for (const key of secrets) expect(text.includes(planted[key]), `${name} holds the planted ${key}`).toBe(false);
      expect(text, name).not.toContain(repo.dir);
      expect(text, name).not.toMatch(/https?:\/\/[^\s/@"<]+:[^\s/@"<]+@/);
    }
    expect(outputs.code.html).toContain(planted.code);
    expect(outputs.code.html).toContain(planted.literalHref);
    expect(outputs.code.html).toContain(planted.literalText);
    expect(outputs.code.html).toMatch(/<pre>[^<]*data-marker=&quot;marker-/);
    expect(outputs.code.html).toContain("https://[redacted]@git.example.com/");
    expect(outputs.code.html).toContain("Lines of code were included (--include-code)");
  });
});

describe("the Redactor's repo root", () => {
  test("is matched only as a whole path: a sibling folder that starts with the same name is outside the repo, never a relative path", () => {
    const redactor = new Redactor({ root: "/home/runner/work/app", home: "/nowhere", username: "", env: {} });
    expect(redactor.text("/home/runner/work/app/src/a.ts and /home/runner/work/app")).toBe("src/a.ts and .");
    expect(redactor.text("path /home/runner/work/app-design")).toBe("path [path outside the repo]");
    expect(redactor.text("/home/runner/work/app.old/x")).toBe("[path outside the repo]");
  });
});

describe("the Redactor's .env values", () => {
  test("a real .env's values are redacted; an .env.example's plain names, often the project's own, are not, but a key pasted into one is, and so is everything in .env.dist", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "youi-dotenv-"));
    try {
      writeFileSync(join(root, ".env"), "API_SECRET=sk-real-value-123456\n");
      writeFileSync(join(root, ".env.example"), "POSTGRES_USER=acmecorp\nDATABASE_URL=postgres://acmecorp:password@localhost/acmecorp\nSTRIPE_KEY=sk_live_51HxQe2ExampleKeyAbc123\n");
      writeFileSync(join(root, ".env.dist"), "MAILER_USER=mailbot\n");
      const redactor = await Redactor.forRepo(root, { home: "/nowhere", username: "", env: {} });
      expect(redactor.text("@acmecorp/ui uses sk-real-value-123456")).toBe("@acmecorp/ui uses [redacted]");
      expect(redactor.text("key sk_live_51HxQe2ExampleKeyAbc123 for mailbot")).toBe("key [redacted] for [redacted]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
