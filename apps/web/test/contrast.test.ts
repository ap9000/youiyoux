import { describe, expect, test } from "vitest";
import { composite, contrastRatio, grade, parseColor } from "../src/data/contrast.ts";

describe("parseColor", () => {
  test("reads 3-, 6- and 8-digit hex", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#171717")).toEqual({ r: 23, g: 23, b: 23, a: 1 });
    expect(parseColor("#00000080")?.a).toBeCloseTo(0.5, 2);
  });

  test("reads modern and legacy rgb() forms with alpha", () => {
    expect(parseColor("rgb(0 0 0 / .32)")).toEqual({ r: 0, g: 0, b: 0, a: 0.32 });
    expect(parseColor("rgba(255, 0, 0, 0.5)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(parseColor("rgb(100% 0% 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  test("returns null for values it cannot resolve", () => {
    expect(parseColor("var(--demo-color-foreground)")).toBeNull();
    expect(parseColor("color-mix(in srgb, red, blue)")).toBeNull();
    expect(parseColor("#12")).toBeNull();
  });
});

describe("contrastRatio", () => {
  test("black on white is 21:1 and a colour on itself is 1:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#5150d6", "#5150d6")).toBeCloseTo(1, 5);
  });

  test("is symmetric", () => {
    expect(contrastRatio("#666666", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#666666")!, 10);
  });

  test("composites a translucent foreground over its background first", () => {
    const half = contrastRatio("rgb(0 0 0 / .5)", "#ffffff")!;
    const mixed = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(mixed.r).toBeCloseTo(127.5, 5);
    expect(half).toBeGreaterThan(3);
    expect(half).toBeLessThan(5);
  });

  test("returns null when either colour is unresolvable", () => {
    expect(contrastRatio("var(--x)", "#fff")).toBeNull();
  });
});

describe("grade", () => {
  test("follows the WCAG thresholds", () => {
    expect(grade(7)).toBe("AAA");
    expect(grade(4.5)).toBe("AA");
    expect(grade(3)).toBe("AA large");
    expect(grade(2.99)).toBe("Fail");
  });
});
