import { describe, expect, test } from "vitest";
import { deleteJsonPath, readJsonPath, setJsonPath } from "../src/index.ts";

const expanded = `{
  "color": {
    "brand": {
      "$type": "color",
      "$value": {
        "colorSpace": "srgb",
        "components": [
          0.3098,
          0.2745,
          0.898
        ],
        "hex": "#4f46e5"
      }
    }
  },
  "platforms": ["web"]
}
`;

describe("in-place JSON edits", () => {
  test("replace one value and leave every other line byte for byte", () => {
    const next = setJsonPath(expanded, ["color", "brand", "$value"], { colorSpace: "srgb", components: [0.3098, 0.2745, 0.5], hex: "#4f4680" });
    expect(next).toBe(expanded.replace("          0.898\n", "          0.5\n").replace('"#4f46e5"', '"#4f4680"'));
    expect(setJsonPath(expanded, ["platforms"], ["web"])).toBe(expanded);
  });

  test("insert missing keys and groups at the right indentation, in expanded and inline objects", () => {
    const next = setJsonPath(expanded, ["color", "accent"], { $type: "color", $value: "{color.brand}" });
    expect(next).toContain('    },\n    "accent": {\n      "$type": "color",\n      "$value": "{color.brand}"\n    }\n  },');
    expect(JSON.parse(next)).toMatchObject({ color: { accent: { $value: "{color.brand}" } } });
    expect(setJsonPath('{ "a": 1 }', ["b", "c"], 2)).toBe('{ "a": 1, "b": {\n  "c": 2\n} }');
    expect(setJsonPath("{}\n", ["a"], 1)).toBe('{\n  "a": 1\n}\n');
  });

  test("delete a member with its comma, and a group it leaves empty", () => {
    const withAccent = setJsonPath(expanded, ["color", "accent"], { $value: 1 });
    expect(deleteJsonPath(withAccent, ["color", "accent"])).toBe(expanded);
    const gone = deleteJsonPath(expanded, ["color", "brand"]);
    expect(JSON.parse(gone)).toEqual({ platforms: ["web"] });
    expect(gone).toBe('{\n  "platforms": ["web"]\n}\n');
    expect(deleteJsonPath(expanded, ["color", "nope"])).toBe(expanded);
    expect(readJsonPath(expanded, ["color", "brand", "$value", "hex"])).toBe("#4f46e5");
  });

  test("refuse malformed JSON instead of guessing", () => {
    expect(() => setJsonPath('{"a": 1,, }', ["a"], 2)).toThrow();
  });
});
