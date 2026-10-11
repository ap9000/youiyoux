/** The element page: dispatches to the component, token or rule view of one element. */
import { FileQuestion } from "lucide-react";
import { Link } from "wouter";
import type { ElementTab } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { TokenDetail } from "../tokens/TokenDetail.tsx";
import { ComponentPage } from "./ComponentPage.tsx";
import { RuleDetail } from "./RuleDetail.tsx";

export function ElementPage({ model, id, tab }: { model: Model; id: string; tab: ElementTab }) {
  const component = model.components.get(id);
  if (component) return <ComponentPage key={id} model={model} entry={component} tab={tab} />;
  const token = model.tokens.get(id);
  if (token) return <TokenDetail key={id} model={model} token={token} />;
  const rule = model.rules.get(id);
  if (rule) return <RuleDetail key={id} model={model} rule={rule} />;
  return (
    <EmptyState
      icon={FileQuestion}
      title="No such element"
      actions={
        <Button asChild>
          <Link href="/elements">All elements</Link>
        </Button>
      }
    >
      <code className="font-mono text-mono-sm">{id}</code> is not part of {model.catalog.system.name} v{model.catalog.system.version}.
    </EmptyState>
  );
}
