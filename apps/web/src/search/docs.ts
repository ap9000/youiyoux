/** Search documents: one flat record per element, built from the model on the main thread. */
import type { Model } from "../data/model.ts";
import type { ComponentEntry, RuleSpec, TokenEntry } from "../data/types.ts";

export interface SearchDoc {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly key: string;
  readonly summary: string;
  /** Everything else worth matching: props, values, guidance, rationale. */
  readonly text: string;
}

const join = (parts: ReadonlyArray<string | undefined>): string => parts.filter(Boolean).join(" ");

function componentText({ contract }: ComponentEntry): string {
  const props = Object.entries(contract.props).flatMap(([name, spec]) => [name, ...(spec.type === "enum" ? spec.values : [])]);
  return join([...props, ...contract.source.also, ...contract.aliases, contract.a11y.role, contract.passthrough, ...contract.guidance.do, ...contract.guidance.dont, ...contract.platforms, contract.status]);
}

function tokenText(token: TokenEntry): string {
  return join([token.type, token.group, token.light, token.dark, ...token.aliasChain.slice(1).map((id) => id.split("/").pop())]);
}

function ruleText(rule: RuleSpec): string {
  return join([rule.rationale, rule.agent, rule.severity, rule.check.engine, "id" in rule.check ? rule.check.id : undefined]);
}

export function toSearchDocs(model: Model): SearchDoc[] {
  return model.elements.map((element) => {
    const component = model.components.get(element.id);
    const token = model.tokens.get(element.id);
    const rule = model.rules.get(element.id);
    const text = component ? componentText(component) : token ? tokenText(token) : rule ? ruleText(rule) : "";
    return { id: element.id, kind: element.kind, name: element.name, key: element.key, summary: element.summary, text };
  });
}
