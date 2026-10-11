import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { elementHref, formatId, parseId, shortName, tabOf, tokenHref } from "../src/data/ids.ts";
import { buildModel, countByKind } from "../src/data/model.ts";
import type { Catalog, Manifest } from "../src/data/types.ts";
import { readSelection } from "../src/screens/catalog/CatalogScreen.tsx";
import { toRows } from "../src/screens/catalog/ElementList.tsx";
import { packageDeps } from "../src/screens/element/ComponentPage.tsx";
import { contrastPairs } from "../src/screens/tokens/TokenDetail.tsx";
import { filterTokens } from "../src/screens/tokens/TokensScreen.tsx";
import { withLoadedFonts } from "../src/screens/tokens/TokenValue.tsx";

const DATA = join(import.meta.dirname, "../snapshot/public/data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
const catalog = JSON.parse(readFileSync(join(DATA, manifest.systems[0]!.catalog), "utf8")) as Catalog;
const model = buildModel(catalog, manifest);

describe("ids", () => {
  test("parse and format round-trip", () => {
    const id = formatId("demo", "token", "color.foreground");
    expect(id).toBe("youi:demo/token/color.foreground");
    expect(parseId(id)).toEqual({ system: "demo", kind: "token", name: "color.foreground" });
    expect(parseId("dl:core/button")).toBeNull();
  });

  test("hub URLs keep the overview tab implicit", () => {
    expect(elementHref("youi:demo/component/button")).toBe("/elements/demo/component/button");
    expect(elementHref("youi:demo/component/button", "overview")).toBe("/elements/demo/component/button");
    expect(elementHref("youi:demo/component/button", "usage")).toBe("/elements/demo/component/button/usage");
    expect(elementHref("nonsense")).toBe("/elements");
    expect(tokenHref("color.ink")).toBe("/tokens/color.ink");
    expect(shortName("youi:demo/rule/color.no-raw-color")).toBe("color.no-raw-color");
  });

  test("readSelection reads the element and tab from the route, defaulting bad tabs to overview", () => {
    expect(readSelection("demo/component/button/usage")).toEqual({ id: "youi:demo/component/button", tab: "usage" });
    expect(readSelection("demo/component/button/bogus").tab).toBe("overview");
    expect(readSelection("demo/widget/button").id).toBeNull();
    expect(readSelection("").id).toBeNull();
  });

  test("links from before the tabs merged land on the tab that now holds their content", () => {
    expect(tabOf("preview")).toBe("overview");
    expect(tabOf("where")).toBe("usage");
    expect(tabOf("tokens")).toBe("contract");
    expect(tabOf("rules")).toBe("rules");
    expect(tabOf(undefined)).toBe("overview");
  });
});

describe("buildModel on the demo snapshot", () => {
  test("orders components, then tokens by group, then rules", () => {
    const kinds = model.elements.map((e) => e.kind);
    expect(kinds.indexOf("token")).toBe(countByKind(model.elements).component);
    expect(kinds.lastIndexOf("component")).toBeLessThan(kinds.indexOf("token"));
    expect(kinds.at(-1)).toBe("rule");
    expect(model.elements.find((e) => e.kind === "token")?.group).toBe("color");
  });

  test("knows which components bind a token and declare a rule", () => {
    const consumers = model.tokenConsumers.get("youi:demo/token/color.danger") ?? [];
    expect(consumers).toContainEqual({ component: "youi:demo/component/button", role: "fg.danger" });
    expect(consumers).toContainEqual({ component: "youi:demo/component/input", role: "border.invalid" });
    expect(model.ruleComponents.get("youi:demo/rule/color.no-raw-color")).toContain("youi:demo/component/button");
  });

  test("alias chains end at the token that holds the value", () => {
    const accent = model.tokenByPath.get("color.accent")!;
    expect(accent.aliasChain).toEqual(["youi:demo/token/color.accent", "youi:demo/token/color.brand"]);
    expect(accent.light).toBe(model.tokenByPath.get("color.brand")!.light);
  });
});

describe("element list rows", () => {
  test("group headers appear only when browsing without a query", () => {
    const grouped = toRows(model.elements, true);
    expect(grouped[0]).toMatchObject({ type: "header", label: "Components", count: 3 });
    expect(grouped.filter((r) => r.type === "item")).toHaveLength(model.elements.length);
    expect(toRows(model.elements, false).every((r) => r.type === "item")).toBe(true);
  });
});

describe("token helpers", () => {
  test("filterTokens matches path, variable and value", () => {
    expect(filterTokens([...model.tokens.values()], "c62828").map((t) => t.path)).toEqual(["color.danger"]);
    expect(filterTokens([...model.tokens.values()], "--demo-color-fore").map((t) => t.path)).toEqual(["color.foreground"]);
    expect(filterTokens([...model.tokens.values()], "")).toHaveLength(model.tokens.size);
  });

  test("contrastPairs pairs on-x with x, x-soft with x, and plain colours with the surfaces", () => {
    const pairs = (path: string) => contrastPairs(model, model.tokenByPath.get(path)!).map((p) => [p.foreground.path, p.background.path]);
    expect(pairs("color.on-accent")).toEqual([["color.on-accent", "color.accent"]]);
    expect(pairs("color.danger-soft")).toEqual([["color.danger", "color.danger-soft"]]);
    // The demo names its surfaces background and card, and its ink foreground (shadcn-style names).
    expect(pairs("color.muted")).toEqual([
      ["color.muted", "color.background"],
      ["color.muted", "color.card"],
    ]);
    expect(pairs("color.card")).toEqual([
      ["color.foreground", "color.card"],
      ["color.muted", "color.card"],
    ]);
    expect(contrastPairs(model, model.tokenByPath.get("radius.card")!)).toEqual([]);
  });

  test("withLoadedFonts points Geist families at the loaded variable faces", () => {
    expect(withLoadedFonts("600 26px/1.2 Geist, ui-sans-serif")).toBe('600 26px/1.2 "Geist Variable", Geist, ui-sans-serif');
    expect(withLoadedFonts('"Geist Mono", ui-monospace')).toBe('"Geist Mono Variable", "Geist Mono", ui-monospace');
  });
});

describe("packageDeps", () => {
  test("lists the npm packages a component's files import, without React or relative paths", () => {
    const button = model.components.get("youi:demo/component/button")!;
    expect(packageDeps(button.files)).toEqual(["class-variance-authority", "clsx", "tailwind-merge"]);
    const scoped = [{ path: "tabs.tsx", code: 'import * as Tabs from "@radix-ui/react-tabs";\nimport { Slot } from "@radix-ui/react-slot/dist";\nimport { cn } from "./utils";' }];
    expect(packageDeps(scoped)).toEqual(["@radix-ui/react-slot", "@radix-ui/react-tabs"]);
  });
});
