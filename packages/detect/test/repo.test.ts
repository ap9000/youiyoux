import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoReport } from "../src/index.ts";
import { RepoPaths } from "../src/paths.ts";

const REPOS = join(import.meta.dirname, "fixtures/repos");

describe("repo detection", () => {
  test("a shadcn app: shadcn and Radix from components.json, data-slot and imports; declared-but-unused MUI and styled-components only in unused", async () => {
    const report = await repoReport(join(REPOS, "shadcn-app"));
    expect(report.target).toMatchObject({ kind: "repo", name: "shadcn-app" });
    const ids = report.libraries.map((l) => l.id);
    expect(ids[0]).toBe("shadcn");
    expect(ids).toContain("radix");
    const shadcn = report.libraries[0]!;
    expect(shadcn.confidence).toBe("high");
    expect(shadcn.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["components-json", "data-slot", "import"]));
    expect(shadcn.evidence.find((e) => e.kind === "data-slot")?.samples).not.toContain("geist-icon");
    expect(report.libraries.find((l) => l.id === "radix")?.evidence.filter((e) => e.kind === "lockfile").map((e) => e.detail)).toContain("pnpm-lock.yaml resolves @radix-ui/react-dialog 1.1.2");

    // Declared but never imported (a type-only import, a comment and a string do not count): reported, not counted.
    expect(report.unused.map((u) => u.package).sort()).toEqual(["@mui/material", "styled-components"]);
    expect(report.unused.find((u) => u.package === "@mui/material")).toEqual({ package: "@mui/material", version: "^6.1.0", declaredIn: "package.json", library: "mui" });
    expect(ids).not.toContain("mui");
    expect(ids).not.toContain("styled-components");
    expect(report.elements.map((e) => e.library)).not.toContain("mui");

    expect(report.elements).toEqual(expect.arrayContaining([expect.objectContaining({ type: "button", library: "shadcn" }), expect.objectContaining({ type: "dialog", library: "shadcn", also: ["radix"] })]));
    expect(report.notes.join(" ")).toContain("geist-icon (1)");
    expect(report.coverage).toContain("declared but never imported packages are listed apart");
  });

  test("an npm-lockfile repo: MUI from its imports, unused antd and Emotion listed apart", async () => {
    const report = await repoReport(join(REPOS, "npm-app"));
    expect(report.libraries.map((l) => l.id)).toEqual(["mui"]);
    const mui = report.libraries[0]!;
    expect(mui.confidence).toBe("high");
    expect(mui.evidence.find((e) => e.kind === "import")).toMatchObject({ count: 3, samples: ["@mui/material", "@mui/material/Tabs", "@mui/material/SvgIcon"] });
    expect(mui.evidence.find((e) => e.kind === "lockfile")?.detail).toBe("package-lock.json resolves @mui/material 6.1.6");
    expect(report.unused.map((u) => u.package).sort()).toEqual(["@emotion/react", "@emotion/styled", "antd"]);
    expect(report.elements.map((e) => e.type).sort()).toEqual(["button", "dialog", "input", "tabs"]);
    expect(report.elements.find((e) => e.type === "button")?.evidence[0]?.where).toEqual(["src/App.jsx:2"]);
    expect(report.fonts).toEqual([{ family: "Roboto", usedBy: ["@fontsource/roboto/400.css"] }]);
  });

  test("a local ui/ kit counts as shadcn through any tsconfig path alias or a relative path, not only @/components/ui", async () => {
    const report = await repoReport(join(REPOS, "alias-app"));
    expect(report.libraries[0]).toMatchObject({ id: "shadcn", confidence: "high" });
    // components.json says "~/ui"; tsconfig.json extends a base whose paths map both ~/* and @lib/* to app/*.
    expect(report.libraries[0]!.evidence.find((e) => e.kind === "import")).toMatchObject({
      count: 3,
      samples: ["~/ui/button", "../ui/dialog", "@lib/ui/card"],
      where: ["app/routes/settings.tsx:2", "app/routes/settings.tsx:3", "app/routes/settings.tsx:4"],
    });
    expect(report.elements.filter((e) => e.library === "shadcn").map((e) => e.type).sort()).toEqual(["button", "card", "dialog"]);
    expect(report.elements.find((e) => e.type === "dialog")).toMatchObject({ library: "shadcn", also: ["radix"] });
    // An alias import outside the kit (~/lib/utils) is not a shadcn import; the declared-unused package stays apart.
    expect(report.libraries[0]!.evidence.flatMap((e) => e.samples ?? [])).not.toContain("~/lib/utils");
    expect(report.unused.map((u) => u.package)).toEqual(["@chakra-ui/react"]);
    expect(report.libraries.map((l) => l.id)).not.toContain("chakra");
  });

  test("without components.json, a components/ui kit of shadcn files reached through a relative barrel counts as shadcn, ranked above Radix", async () => {
    const report = await repoReport(join(REPOS, "barrel-app"));
    expect(report.libraries[0]).toMatchObject({ id: "shadcn", confidence: "high" });
    const ids = report.libraries.map((l) => l.id);
    expect(ids.indexOf("shadcn")).toBeLessThan(ids.indexOf("radix"));
    // page.tsx imports ../components/ui/index.js; toolbar.tsx the plain ../components/ui directory.
    expect(report.libraries[0]!.evidence.find((e) => e.kind === "import")).toMatchObject({
      count: 2,
      samples: ["../components/ui/index.js", "../components/ui"],
      where: ["src/app/page.tsx:2", "src/app/toolbar.tsx:1"],
    });
    const shadcnElements = report.elements.filter((e) => e.library === "shadcn");
    expect(shadcnElements.map((e) => e.type).sort()).toEqual(["button", "dialog", "tabs"]);
    expect(report.elements.find((e) => e.type === "tabs")).toMatchObject({ library: "shadcn", also: ["radix"] });
    expect(report.elements.find((e) => e.type === "dialog")).toMatchObject({ library: "shadcn", also: ["radix"] });
    expect(report.elements.find((e) => e.type === "button")?.evidence[0]?.detail).toContain("from ../components/ui");
    expect(report.elements.map((e) => e.library)).not.toContain("radix");
    expect(report.coverage).toContain("no components.json (ui kit at src/components/ui (button, dialog, tabs))");
  });

  test("a components/ui folder is not a shadcn kit without two shadcn-named files that use cva or shadcn data-slot names", async () => {
    const root = await mkdtemp(join(tmpdir(), "youi-kit-"));
    try {
      await mkdir(join(root, "src/components/ui"), { recursive: true });
      await writeFile(join(root, "package.json"), `{ "name": "plain-ui", "dependencies": { "react": "19.0.0" } }`);
      await writeFile(join(root, "src/components/ui/foo.tsx"), `export const Foo = () => <div className={cva("foo")()} />;`);
      await writeFile(join(root, "src/components/ui/button.tsx"), `export const Button = () => <button className="btn" />;`);
      await writeFile(join(root, "src/components/ui/tabs.tsx"), `export const Tabs = () => <div className={cva("tabs")()} />;`);
      await writeFile(join(root, "src/app.tsx"), `import { Button, Tabs } from "./components/ui/button";\nimport { Foo } from "./components/ui/foo";`);
      const report = await repoReport(root);
      expect(report.libraries.map((l) => l.id)).not.toContain("shadcn");
      expect(report.coverage).toContain("no components.json,");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("path aliases resolve the way TypeScript does: exact first, then the longest prefix, then baseUrl", async () => {
    const root = await mkdtemp(join(tmpdir(), "youi-paths-"));
    try {
      await mkdir(join(root, "web/src/ui"), { recursive: true });
      await writeFile(join(root, "tsconfig.base.json"), `{ "compilerOptions": { "baseUrl": "web/src", /* comment */ "paths": { "@/*": ["*"], "@/ui/*": ["ui/*"], "kit": ["ui/index.ts"] } } }`);
      await writeFile(join(root, "web/tsconfig.json"), `// extends the root config\n{ "extends": "../tsconfig.base.json" }`);
      await writeFile(join(root, "web/src/ui/button.tsx"), "export {};");
      await writeFile(join(root, "web/src/ui/index.ts"), "export {};");
      const paths = new RepoPaths(root);
      expect(paths.resolve("@/ui/button", "web/src/app/page.tsx")).toBe("web/src/ui/button");
      expect(paths.resolve("@/lib/utils", "web/src/app/page.tsx")).toBe("web/src/lib/utils");
      expect(paths.resolve("kit", "web/src/app/page.tsx")).toBe("web/src/ui/index.ts");
      expect(paths.resolve("ui/button", "web/src/app/page.tsx")).toBe("web/src/ui/button");
      expect(paths.resolve("../ui/button", "web/src/app/page.tsx")).toBe("web/src/ui/button");
      expect(paths.resolve("react", "web/src/app/page.tsx")).toBeNull();
      // Outside web/ no config applies: only relative paths resolve.
      expect(paths.resolve("@/ui/button", "scripts/build.ts")).toBeNull();
      expect(paths.resolve("../../outside", "scripts/build.ts")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a directory without package.json is refused, not reported as empty", async () => {
    await expect(repoReport(join(REPOS, "npm-app/src"))).rejects.toThrowError(/has no package.json/);
  });
});
