/** A live edit written into the code: literal props and plain text changed on the element at a line, and everything else refused with why. */
import { describe, expect, test } from "vitest";
import { editJsx, type JsxEdit } from "../src/index.ts";

const FILE = [
  'import { Button as Action, Badge } from "./ui";',
  "export function Toolbar({ rest, label }: { rest: object; label: string }) {",
  "  return (",
  "    <div>",
  '      <Button variant="outline" size="sm">New flow</Button>',
  "      <Button disabled>Save</Button>",
  "      <Badge tone={'info'} count={3} />",
  "      <Button variant={label ? \"ghost\" : \"outline\"}>{label}</Button>",
  "      <Button {...rest} variant=\"ghost\">Spread</Button>",
  "      <Action>Renamed</Action>",
  "      <Button",
  '        variant="outline"',
  "      >",
  "        Many lines",
  "      </Button>",
  "    </div>",
  "  );",
  "}",
  "",
].join("\n");
const at = (line: number, patch: Partial<JsxEdit> = {}): JsxEdit => ({ line, component: "Button", set: [], ...patch });
const edit = (e: JsxEdit) => editJsx(FILE, "src/toolbar.tsx", e);
const line = (source: string, n: number): string => source.split("\n")[n - 1]!;

describe("a live edit written into the code", () => {
  test("a literal prop is changed in place, keeping its quotes, and a prop the code doesn't name is added", () => {
    const changed = edit(at(5, { set: [{ prop: "variant", value: "default" }, { prop: "loading", value: true }] }));
    expect(changed.ok && line(changed.source, 5)).toBe('      <Button variant="default" size="sm" loading>New flow</Button>');
    const badge = edit(at(7, { component: "Badge", set: [{ prop: "tone", value: "warning" }, { prop: "count", value: 4 }] }));
    expect(badge.ok && line(badge.source, 7)).toBe('      <Badge tone="warning" count={4} />');
    // What the preview shows: the element's lines, before and after.
    expect(changed.ok && [changed.tag, changed.line, changed.before, changed.after]).toEqual(["Button", 5, line(FILE, 5), '      <Button variant="default" size="sm" loading>New flow</Button>']);
  });

  test("setting the contract's default takes the attribute out; false and text with quotes or braces are written so JSX reads them", () => {
    const back = edit(at(5, { set: [{ prop: "size", value: "md", default: "md" }] }));
    expect(back.ok && line(back.source, 5)).toBe('      <Button variant="outline">New flow</Button>');
    const off = edit(at(6, { set: [{ prop: "disabled", value: false }] }));
    expect(off.ok && line(off.source, 6)).toBe("      <Button disabled={false}>Save</Button>");
    const quoted = edit(at(5, { set: [{ prop: "variant", value: 'say "hi" {x}' }] }));
    expect(quoted.ok && line(quoted.source, 5)).toBe('      <Button variant={"say \\"hi\\" {x}"} size="sm">New flow</Button>');
  });

  test("plain text is replaced, across lines too; an attribute added to an element over many lines goes on its own line", () => {
    const text = edit(at(5, { text: "Create flow" }));
    expect(text.ok && line(text.source, 5)).toBe('      <Button variant="outline" size="sm">Create flow</Button>');
    const braces = edit(at(6, { text: "Save {now}" }));
    expect(braces.ok && line(braces.source, 6)).toBe('      <Button disabled>{"Save {now}"}</Button>');
    const many = edit(at(11, { set: [{ prop: "size", value: "lg" }], text: "Fewer lines" }));
    expect(many.ok && many.source.split("\n").slice(10, 16)).toEqual(["      <Button", '        variant="outline"', '        size="lg"', "      >", "        Fewer lines", "      </Button>"]);
  });

  test("an import renamed is found by the name it is imported as", () => {
    const renamed = edit(at(10, { set: [{ prop: "variant", value: "ghost" }] }));
    expect(renamed.ok && [renamed.tag, line(renamed.source, 10)]).toEqual(["Action", '      <Action variant="ghost">Renamed</Action>']);
  });

  test("a value computed in code, props spread in, text from code, a moved line and props a live edit never sets are refused, with why", () => {
    const why = (e: JsxEdit): string => {
      const result = edit(e);
      return result.ok ? "written" : result.why;
    };
    expect(why(at(8, { set: [{ prop: "variant", value: "ghost" }] }))).toMatch(/^variant is computed in code \(variant=\{label \? "ghost" : "outline"\}\)/);
    expect(why(at(9, { set: [{ prop: "size", value: "lg" }] }))).toMatch(/spreads props in \(\{\.\.\.rest\}\), which can set size too/);
    expect(why(at(9, { set: [{ prop: "variant", value: "outline" }] }))).toBe("written");
    expect(why(at(8, { text: "Hi" }))).toMatch(/text isn't written as plain text in the code/);
    expect(why(at(7, { component: "Badge", text: "Hi" }))).toMatch(/has no children in the code/);
    expect(why(at(3, { set: [{ prop: "variant", value: "ghost" }] }))).toMatch(/no JSX element starts on line 3 any more: .* capture it again/);
    expect(why(at(7, { set: [{ prop: "variant", value: "ghost" }] }))).toMatch(/no Button starts on line 7/);
    expect(why(at(5, { set: [{ prop: "dangerouslySetInnerHTML", value: "x" }] }))).toMatch(/isn't a prop a live edit sets/);
    for (const prop of ["href", "src", "style", "className", "onClick", "formAction"]) expect(why(at(5, { set: [{ prop, value: "x" }] }))).toMatch(/isn't a prop a live edit sets: it can carry a URL, HTML, a style or a handler/);
    expect(why(at(5, { set: [{ prop: "variant", value: "javascript:alert(1)" }] }))).toMatch(/value is a script address/);
    expect(why(at(5, { set: [{ prop: "variant", value: "java\nscript:alert(1)" }] }))).toMatch(/value is a script address/);
    expect(why(at(5, { set: [{ prop: "constructor", value: "x" }] }))).toMatch(/isn't a prop a live edit sets/);
    expect(why(at(5, { set: [{ prop: "variant", value: "outline" }] }))).toBe("the code already says this");
  });
});
