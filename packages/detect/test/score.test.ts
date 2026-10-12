import { describe, expect, test } from "vitest";
import { LIBRARIES, SHADCN_SLOTS } from "../src/fingerprints.ts";
import { scoreElements, scoreLibraries, type Signal } from "../src/score.ts";
import { radixScales, siteSignals, type PageFacts } from "../src/site-signals.ts";

const URL = "https://example.test/";
const facts = (over: Partial<PageFacts>): PageFacts => ({ url: URL, title: "t", classes: {}, rootVars: [], ids: {}, dataSlots: {}, styleTags: {}, tailwind: { utility: 0, total: 0 }, fonts: [], elements: [], ...over });
const verdicts = (f: PageFacts) => {
  const { signals, hits, notes } = siteSignals(f);
  const libraries = scoreLibraries(signals);
  return { libraries, elements: scoreElements(hits, libraries), notes, ids: libraries.map((l) => l.id) };
};
const RADIX_GRAY = Array.from({ length: 12 }, (_, i) => `--gray-${i + 1}`);
const DENSE = { utility: 80, total: 100 };

describe("the fingerprint table", () => {
  test("every library has a unique id and only shadcn's own slot names count", () => {
    expect(new Set(LIBRARIES.map((l) => l.id)).size).toBe(LIBRARIES.length);
    expect(SHADCN_SLOTS.has("dialog-content")).toBe(true);
    expect(SHADCN_SLOTS.has("geist-icon")).toBe(false);
  });
});

describe("false positives", () => {
  test("data-slot='geist-icon' never yields shadcn, and is noted as not counted", () => {
    const { ids, notes } = verdicts(facts({ dataSlots: { "geist-icon": 14 }, tailwind: DENSE }));
    expect(ids).not.toContain("shadcn");
    expect(notes.join(" ")).toMatch(/not shadcn\/ui's were not counted: geist-icon \(14\)/);
  });

  test("ui.shadcn.com-style slots from the current registry count toward shadcn; geist-icon beside them still does not", () => {
    const current = ["field", "field-label", "item", "item-title", "empty", "empty-title", "input-group", "input-group-control", "button-group", "sidebar-group-label", "sidebar-group-content", "progress-track", "kbd", "spinner", "native-select"];
    for (const name of current) expect(SHADCN_SLOTS.has(name), name).toBe(true);
    const { libraries, notes } = verdicts(facts({ dataSlots: { ...Object.fromEntries(current.map((name) => [name, 2])), "geist-icon": 9 }, tailwind: DENSE }));
    expect(libraries[0]).toMatchObject({ id: "shadcn" });
    const slots = libraries[0]!.evidence.find((e) => e.kind === "data-slot");
    expect(slots).toMatchObject({ strength: "strong", count: current.length * 2 });
    expect(notes.join(" ")).toMatch(/not counted: geist-icon \(9\)$/);
  });

  test("--geist- or --ds- alone never yields shadcn, and Geist itself stays low", () => {
    for (const vars of [["--geist-foreground", "--geist-background"], ["--ds-gray-100", "--ds-blue-700"]]) {
      const { libraries, ids } = verdicts(facts({ rootVars: vars, dataSlots: { "geist-icon": 2 }, tailwind: DENSE }));
      expect(ids).toEqual(["geist"]);
      expect(libraries[0]!.confidence).toBe("low");
    }
  });

  test("Radix Colors scales and Tailwind density only support a verdict, never decide one", () => {
    expect(verdicts(facts({ rootVars: RADIX_GRAY, tailwind: DENSE })).ids).toEqual([]);
    const alone = verdicts(facts({ ids: { "radix-": { count: 4, samples: ["radix-:r1:"] } } }));
    const supported = verdicts(facts({ ids: { "radix-": { count: 4, samples: ["radix-:r1:"] } }, rootVars: RADIX_GRAY, tailwind: DENSE }));
    expect(alone.libraries[0]!.id).toBe("radix");
    expect(supported.libraries[0]!.score).toBeGreaterThan(alone.libraries[0]!.score);
    expect(supported.libraries[0]!.evidence.map((e) => e.strength)).toEqual(["strong", "support", "support"]);
  });

  test("a single stray class is weak: low confidence, never a strong verdict", () => {
    const { libraries } = verdicts(facts({ classes: { antd: { count: 1, samples: ["ant-anchor"] } } }));
    expect(libraries).toMatchObject([{ id: "antd", confidence: "low" }]);
  });
});

describe("verdicts", () => {
  test("two strong kinds make a high verdict; elements go to it", () => {
    const { libraries, elements } = verdicts(
      facts({
        classes: { mui: { count: 40, samples: ["MuiButton-root"] } },
        rootVars: ["--mui-palette-primary-main"],
        elements: [{ library: "mui", type: "button", selector: ".MuiButton-root", count: 3 }],
      }),
    );
    expect(libraries[0]).toMatchObject({ id: "mui", confidence: "high" });
    expect(elements).toMatchObject([{ type: "button", library: "mui", confidence: "high", count: 3 }]);
  });

  test("a kit outranks the primitives it is built on, and takes the shared element", () => {
    const { ids, elements } = verdicts(
      facts({
        dataSlots: { button: 3, "dialog-content": 1, card: 2 },
        ids: { "radix-": { count: 3, samples: ["radix-:r1:"] } },
        tailwind: DENSE,
        elements: [
          { library: "shadcn", type: "dialog", selector: '[data-slot="dialog-content"]', count: 1 },
          { library: "radix", type: "dialog", selector: '[role="dialog"][id^="radix-"]', count: 1 },
        ],
      }),
    );
    expect(ids.slice(0, 2)).toEqual(["shadcn", "radix"]);
    expect(elements).toMatchObject([{ type: "dialog", library: "shadcn", also: ["radix"] }]);
  });

  test("elements of libraries without a verdict are dropped", () => {
    const signals: Signal[] = [{ library: "radix", kind: "radix-colors", strength: "support", detail: "x", count: 1 }];
    expect(scoreElements([{ library: "radix", type: "dialog", kind: "id-prefix", detail: "x", count: 1 }], scoreLibraries(signals))).toEqual([]);
  });

  test("radix scales need all twelve steps", () => {
    expect(radixScales([...RADIX_GRAY, "--blue-1", "--blue-2"])).toEqual(["gray"]);
  });
});
