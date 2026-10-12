/**
 * Component states: for each contract that declares them, the token each state uses per role
 * (hover's `bg.default`, focus's `ring`). Re-binding one is a contract change in the draft.
 * Focusing a state's controls pins that state in the preview.
 */
import { clsx } from "clsx";
import type { StyleDraftContent } from "@youiyoux/workflow/api";
import type { PinnedState } from "../../preview/pin.ts";
import { Badge } from "../../ui/Badge.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { MousePointerClick } from "lucide-react";
import { INPUT, ResetButton } from "./fields.tsx";
import { STATES, type EditAction, type EditorModel } from "./model.ts";

const STATE_LABEL = { hover: "Hover", active: "Pressed", focus: "Keyboard focus", disabled: "Disabled" } as const;

export function StatesPanel({ model, content, dispatch, onPin, pinned }: { model: EditorModel; content: StyleDraftContent; dispatch: (action: EditAction) => void; onPin: (state: PinnedState) => void; pinned: PinnedState | null }) {
  const contracts = model.contracts.filter((c) => c.states && Object.keys(c.states).length > 0);
  if (contracts.length === 0) {
    return (
      <EmptyState icon={MousePointerClick} title="No component declares states">
        Add <code className="font-mono text-mono-sm">states</code> to a contract (hover, active, focus, disabled → role → token) and the token build gives its implementation one variable per binding to read.
      </EmptyState>
    );
  }
  const pathOf = (id: string): string => id.split("/token/")[1] ?? id;
  return (
    <div className="space-y-4">
      {contracts.map((contract) => (
        <section key={contract.id} className="space-y-3 rounded-lg border border-line p-3" aria-label={`${contract.name} states`}>
          <h3 className="text-heading">{contract.name}</h3>
          {STATES.filter((state) => contract.states?.[state]).map((state) => (
            <fieldset key={state} onFocus={() => onPin(state)} className={clsx("space-y-1.5 rounded-md p-2", pinned === state ? "bg-raised" : "")}>
              <legend className="flex items-center gap-2 text-small font-medium text-ink-2">
                {STATE_LABEL[state]}
                {pinned === state && <Badge tone="accent">Pinned in preview</Badge>}
              </legend>
              {Object.entries(contract.states![state]!).map(([role, published]) => {
                const edit = content.states.find((s) => s.component === contract.id && s.state === state && s.role === role);
                const current = edit?.token ?? published;
                const type = model.byPath.get(pathOf(published))?.type;
                const options = model.tokens.filter((t) => t.type === type);
                const label = `${contract.name} ${state} ${role}`;
                return (
                  <div key={role} className="flex flex-wrap items-center gap-2">
                    <code className="w-24 shrink-0 font-mono text-mono-sm text-muted">{role}</code>
                    <select aria-label={label} value={current} onChange={(event) => dispatch({ type: "state", component: contract.id, state, role, token: event.target.value })} className={clsx(INPUT, "h-7 min-w-0 flex-1 pr-7 font-mono text-mono-sm")}>
                      {options.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.path}
                        </option>
                      ))}
                    </select>
                    {edit && <ResetButton label={`Reset ${label}`} onClick={() => dispatch({ type: "reset-state", component: contract.id, state, role })} />}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </section>
      ))}
    </div>
  );
}
