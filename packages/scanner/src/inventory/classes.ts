/**
 * What a `className` / `class` expression statically says. Classes every branch has are
 * certain; classes only some branches have, and anything computed, are listed as unresolved.
 * A call to a CVA function is kept so its table can be read with the call's variants.
 */
import { Lang, parseAsync, type SgNode } from "@ast-grep/napi";
import { unquote } from "../parse.ts";

export interface ClassValue {
  readonly certain: string[];
  /** Classes some branches add (`active && "x"`, one side of a ternary). */
  readonly conditional: string[];
  /** Expressions that cannot be read (`ui-button--${size}`, a variable). */
  readonly dynamic: string[];
  /** Calls to a function that may be a CVA table: `buttonVariants({ size })`. */
  readonly calls: Array<{ readonly callee: string; readonly args: SgNode | null }>;
  /** The expression forwards the caller's className (`cn("…", className)`). */
  passthrough: boolean;
}

const HELPERS = new Set(["cn", "clsx", "cx", "twMerge", "twJoin", "classNames", "classnames", "tw"]);
const MAX = 80;

const empty = (): ClassValue => ({ certain: [], conditional: [], dynamic: [], calls: [], passthrough: false });
const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const short = (text: string): string => {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
};

function merge(into: ClassValue, from: ClassValue): ClassValue {
  into.certain.push(...from.certain);
  into.conditional.push(...from.conditional);
  into.dynamic.push(...from.dynamic);
  into.calls.push(...from.calls);
  into.passthrough ||= from.passthrough;
  return into;
}

function asConditional(value: ClassValue): ClassValue {
  return { certain: [], conditional: [...value.certain, ...value.conditional], dynamic: value.dynamic, calls: [], passthrough: value.passthrough };
}

function isPassthrough(text: string): boolean {
  return /^(?:className|class|props\.className|props\.class|Astro\.props\.class|\w*ClassName)$/.test(text);
}

export function classValueOf(node: SgNode | null | undefined): ClassValue {
  if (!node) return empty();
  const kind = String(node.kind());
  const text = node.text();
  switch (kind) {
    case "string":
    case "string_fragment":
      return { ...empty(), certain: words(unquote(text)) };
    case "template_string": {
      if (!text.includes("${")) return { ...empty(), certain: words(unquote(text)) };
      // Static words are certain; a word glued to ${…} is not.
      const value = empty();
      for (const token of words(unquote(text).replace(/\$\{[^}]*\}/g, "\u0000"))) {
        if (token.includes("\u0000")) value.dynamic.push(short(token.replace(/\u0000/g, "${…}")));
        else value.certain.push(token);
      }
      return value;
    }
    case "jsx_expression":
    case "parenthesized_expression":
      return classValueOf(node.children().find((c) => c.isNamed() && c.kind() !== "comment"));
    case "call_expression": {
      const callee = node.field("function")?.text() ?? "";
      const args = node.field("arguments")?.children().filter((c) => c.isNamed() && c.kind() !== "comment") ?? [];
      if (HELPERS.has(callee)) return args.reduce((value, arg) => merge(value, classValueOf(arg)), empty());
      if (/^[A-Za-z_$][\w$]*$/.test(callee)) {
        const object = args.find((a) => a.kind() === "object") ?? null;
        const value = { ...empty(), calls: [{ callee, args: object }] };
        // `buttonVariants({ variant, className })` forwards the caller's className too.
        if (object?.findAll({ rule: { any: [{ kind: "shorthand_property_identifier" }, { kind: "property_identifier" }] } }).some((k) => k.text() === "className")) value.passthrough = true;
        return value;
      }
      return { ...empty(), dynamic: [short(text)] };
    }
    case "array":
      return node.children().filter((c) => c.isNamed()).reduce((value, item) => merge(value, classValueOf(item)), empty());
    case "ternary_expression": {
      const yes = classValueOf(node.field("consequence"));
      const no = classValueOf(node.field("alternative"));
      const both = yes.certain.filter((c) => no.certain.includes(c));
      return {
        certain: both,
        conditional: [...yes.certain, ...no.certain].filter((c) => !both.includes(c)).concat(yes.conditional, no.conditional),
        dynamic: [...yes.dynamic, ...no.dynamic],
        calls: [...yes.calls, ...no.calls],
        passthrough: yes.passthrough || no.passthrough,
      };
    }
    case "binary_expression": {
      const right = classValueOf(node.field("right"));
      const operator = node.field("operator")?.text() ?? node.children().find((c) => !c.isNamed())?.text();
      if (operator === "&&") return asConditional(right);
      if (operator === "||" || operator === "??") return merge(asConditional(classValueOf(node.field("left"))), asConditional(right));
      if (operator === "+") return merge(classValueOf(node.field("left")), right);
      return { ...empty(), dynamic: [short(text)] };
    }
    case "object":
      return { ...empty(), conditional: node.children().filter((c) => c.kind() === "pair").map((p) => unquote(p.field("key")?.text() ?? "")).flatMap(words) };
    case "identifier":
    case "member_expression":
      return isPassthrough(text) ? { ...empty(), passthrough: true } : { ...empty(), dynamic: [short(text)] };
    default:
      return { ...empty(), dynamic: [short(text)] };
  }
}

/** The class attribute of a JSX element (`className`, or `class` in Astro-style JSX). */
export function jsxClassAttribute(element: SgNode): SgNode | null {
  for (const child of element.children()) {
    if (child.kind() !== "jsx_attribute") continue;
    const [name, value] = child.children().filter((c) => c.kind() !== "=");
    if (name && (name.text() === "className" || name.text() === "class")) return value ?? null;
  }
  return null;
}

/** An Astro `{…}` expression, parsed as TypeScript. */
export async function parseExpression(source: string): Promise<SgNode | null> {
  const root = (await parseAsync(Lang.TypeScript, `(${source});`)).root();
  const statement = root.children().find((c) => c.kind() === "expression_statement");
  return statement?.children().find((c) => c.isNamed()) ?? null;
}
