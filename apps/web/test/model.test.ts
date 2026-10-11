import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { elementHref, formatId, parseId, shortName, tokenHref } from "../src/data/ids.ts";
import { buildModel, countByKind } from "../src/data/model.ts";
import type { Catalog, Manifest } from "../src/data/types.ts";
import { readSelection } from "../src/screens/catalog/CatalogScreen.tsx";
import { toRows } from "../src/screens/catalog/ElementList.tsx";
import { packageDeps } from "../src/screens/element/ComponentPage.tsx";
import { contrastPairs } from "../src/screens/tokens/TokenDetail.tsx";
import { filterTokens } from "../src/screens/tokens/TokensScreen.tsx";
import { withLoadedFonts } from "../src/screens/tokens/TokenValue.tsx";

const DATA = join(import.meta.dirname, "../public/data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as Manifest;
const catalog = JSON.parse(readFileSync(join(DATA, manifest.systems[0]!.catalog), "utf8")) as Catalog;
const model = buildModel(catalog, manifest);

describe("ids", () => {
  test("parse and format round-trip", () => {
    const id = formatId("signal", "token", "color.ink");
    expect(id).toBe("youi:signal/token/color.ink");
    expect(parseId(id)).toEqual({ system: "signal", kind: "token", name: "color.ink" });
    expect(parseId("dl:core/button")).toBeNull();
  });

  test("hub URLs keep the preview tab implicit", () => {
    expect(elementHref("youi:signal/component/button")).toBe("/elements/signal/component/button");
    expect(elementHref("youi:signal/component/button", "where")).toBe("/elements/signal/component/button/where");
    expect(elementHref("nonsense")).toBe("/elements");
    expect(tokenHref("color.ink")).toBe("/tokens/color.ink");
    expect(shortName("youi:signal/rule/color.no-raw-color")).toBe("color.no-raw-color");
  });

  test("readSelection reads the element and tab from the route, defaulting bad tabs to preview", () => {
    expect(readSelection("signal/component/button/where")).toEqual({ id: "youi:signal/component/button", tab: "where" });
    expect(readSelection("signal/component/button/bogus").tab).toBe("preview");
    expect(readSelection("signal/widget/button").id).toBeNull();
    expect(readSelection("").id).toBeNull();
  });
});

describe("buildModel on the Signal snapshot", () => {
  test("orders components, then tokens by group, then rules", () => {
    const kinds = model.elements.map((e) => e.kind);
    expect(kinds.indexOf("token")).toBe(countByKind(model.elements).component);
    expect(kinds.lastIndexOf("component")).toBeLessThan(kinds.indexOf("token"));
    expect(kinds.at(-1)).toBe("rule");
    expect(model.elements.find((e) => e.kind === "token")?.group).toBe("color");
  });

  test("knows which components bind a token and declare a rule", () => {
    const consumers = model.tokenConsumers.get("youi:signal/token/color.attention") ?? [];
    expect(consumers).toContainEqual({ component: "youi:signal/component/button", role: "bg.attention" });
    expect(model.ruleComponents.get("youi:signal/rule/color.no-raw-color")).toContain("youi:signal/component/button");
  });

  test("alias chains end at the token that holds the value", () => {
    const attention = model.tokenByPath.get("color.attention")!;
    expect(attention.aliasChain).toEqual(["youi:signal/token/color.attention", "youi:signal/token/color.signal"]);
    expect(attention.light).toBe(model.tokenByPath.get("color.signal")!.light);
  });
});

describe("element list rows", () => {
  test("group headers appear only when browsing without a query", () => {
    const grouped = toRows(model.elements, true);
    expect(grouped[0]).toMatchObject({ type: "header", label: "Components", count: 8 });
    expect(grouped.filter((r) => r.type === "item")).toHaveLength(model.elements.length);
    expect(toRows(model.elements, false).every((r) => r.type === "item")).toBe(true);
  });
});

describe("token helpers", () => {
  test("filterTokens matches path, variable and value", () => {
    expect(filterTokens([...model.tokens.values()], "c4320a").map((t) => t.path)).toEqual(["color.danger"]);
    expect(filterTokens([...model.tokens.values()], "--so-ink").map((t) => t.path)).toContain("color.ink");
    expect(filterTokens([...model.tokens.values()], "")).toHaveLength(model.tokens.size);
  });

  test("contrastPairs pairs on-x with x, x-soft with x, and plain colours with the surfaces", () => {
    const pairs = (path: string) => contrastPairs(model, model.tokenByPath.get(path)!).map((p) => [p.foreground.path, p.background.path]);
    expect(pairs("color.on-accent")).toEqual([["color.on-accent", "color.accent"]]);
    expect(pairs("color.danger-soft")).toEqual([["color.danger", "color.danger-soft"]]);
    expect(pairs("color.muted")).toEqual([
      ["color.muted", "color.paper"],
      ["color.muted", "color.ground"],
      ["color.muted", "color.raised"],
    ]);
    expect(pairs("color.paper")).toEqual([
      ["color.ink", "color.paper"],
      ["color.muted", "color.paper"],
    ]);
    expect(contrastPairs(model, model.tokenByPath.get("radius.md")!)).toEqual([]);
  });

  test("withLoadedFonts points Geist families at the loaded variable faces", () => {
    expect(withLoadedFonts("600 26px/1.2 Geist, ui-sans-serif")).toBe('600 26px/1.2 "Geist Variable", Geist, ui-sans-serif');
    expect(withLoadedFonts('"Geist Mono", ui-monospace')).toBe('"Geist Mono Variable", "Geist Mono", ui-monospace');
  });
});

describe("packageDeps", () => {
  test("lists the npm packages a component's files import, without React or relative paths", () => {
    const button = model.components.get("youi:signal/component/button")!;
    expect(packageDeps(button.files)).toEqual(["@radix-ui/react-slot", "class-variance-authority", "clsx", "tailwind-merge"]);
  });
});
