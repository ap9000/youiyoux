/**
 * Edit, on a component picked on a live screen: the choices its design-system contract gives (each
 * enum prop's values, its switches, its text and numbers) and its text, applied in the running app
 * as they are changed (LiveHandle), so a person sees the real result. Then the change goes into the
 * code: shown first (the element's lines before and after), and written by the local service only
 * while the file is still the one shown. What can't be written that way (a value computed in code,
 * props spread in, no file and line) is said, and can be filed as an exact change request instead.
 */
import { useEffect, useRef, useState } from "react";
import type { ComponentContract, PropSpec, RequestDoc, RequestTarget } from "@youiyoux/core";
import type { LiveHandle, LiveProps, LiveValue } from "../../data/live.ts";
import { asRequestError, workflowApi, type LiveCodeEdit, type WorkflowRequestError } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { Select, TextInput } from "../../ui/Field.tsx";

type Editable = Extract<PropSpec, { type: "enum" | "string" | "boolean" | "number" }>;

/** The props a live edit offers: those the contract types as a value, never a function or a node. */
export function editableProps(contract: ComponentContract | null): Array<[string, Editable]> {
  if (!contract) return [];
  return Object.entries(contract.props).filter((entry): entry is [string, Editable] => ["enum", "string", "boolean", "number"].includes(entry[1].type) && !entry[1].deprecated);
}

/** The change in words, for a request: what to set, on what, where. */
export function editWords(name: string, target: RequestTarget, set: Readonly<Record<string, LiveValue>>, text: string | null): string {
  const parts = [...Object.entries(set).map(([prop, value]) => (value === true ? prop : `${prop}=${JSON.stringify(value)}`)), ...(text === null ? [] : [`its text to ${JSON.stringify(text)}`])];
  const where = target.file && target.line ? ` at ${target.file}:${target.line}` : "";
  return `Set ${parts.join(", ")} on ${name}${where}, as previewed live on ${target.route}.`;
}

interface Props {
  live: LiveHandle;
  /** The component as the page names it (what the bridge finds it by) and as the hub names it. */
  component: string;
  /** Where its JSX starts on its line, when the capture found it. */
  column: number | null;
  name: string;
  contract: ComponentContract | null;
  target: RequestTarget;
  onFiled: (request: RequestDoc) => void;
  onDone: () => void;
}

export function LiveEditor({ live, component, column, name, contract, target, onFiled, onDone }: Props) {
  const props = editableProps(contract);
  const [now, setNow] = useState<LiveProps | null>(null);
  const [set, setSet] = useState<Record<string, LiveValue>>({});
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<Extract<LiveCodeEdit, { ok: true }> | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WorkflowRequestError | null>(null);

  useEffect(() => {
    let current = true;
    void live.ask(props.map(([key]) => key)).then((answer) => current && setNow(answer));
    return () => {
      current = false;
    };
    // Asked once per pick: the handle is the pick.
  }, [live]);

  // Leaving without writing puts the page back as it was; once written, the code says the same.
  const kept = useRef(false);
  useEffect(() => () => void (!kept.current && live.reset()), [live]);

  const changed = Object.keys(set).length > 0 || text !== null;
  const apply = (nextSet: Record<string, LiveValue>, nextText: string | null): void => {
    setSet(nextSet);
    setText(nextText);
    setShown(null);
    setRefused(null);
    void live.edit(nextSet, nextText).then((done) => setProblem(done.ok ? null : done.why));
  };
  const valueOf = (key: string, spec: Editable): LiveValue | null => (key in set ? set[key]! : (now?.props[key] ?? spec.default ?? null));
  const change = (key: string, value: LiveValue): void => apply({ ...set, [key]: value }, text);

  const edit = () => ({
    file: target.file!,
    line: target.line!,
    column,
    component,
    // With the contract's default, so setting it takes the attribute out.
    set: Object.entries(set).map(([prop, value]) => {
      const spec = props.find(([key]) => key === prop)?.[1];
      return { prop, value, ...(spec?.default !== undefined ? { default: spec.default } : {}) };
    }),
    text,
  });
  const show = (): void => {
    setBusy(true);
    setError(null);
    workflowApi
      .liveEdit(edit())
      .then(
        (result) => (result.ok ? setShown(result) : setRefused(result.why)),
        (e: unknown) => setError(asRequestError(e)),
      )
      .finally(() => setBusy(false));
  };
  const write = (): void => {
    if (!shown) return;
    setBusy(true);
    setError(null);
    workflowApi
      .liveEdit({ ...edit(), write: { hash: shown.hash } })
      .then(
        (result) => {
          if (!result.ok) return setRefused(result.why);
          kept.current = true;
          live.forget();
          setWritten(`${result.file}:${result.line}`);
        },
        (e: unknown) => setError(asRequestError(e)),
      )
      .finally(() => setBusy(false));
  };
  const file = (): void => {
    setBusy(true);
    setError(null);
    workflowApi
      .fileRequest("change", editWords(name, target, set, text), target)
      .then((request) => onFiled(request), (e: unknown) => setError(asRequestError(e)))
      .finally(() => setBusy(false));
  };

  if (written)
    return (
      <div className="space-y-2" data-live-edit="written">
        <p className="text-small text-ink-2">
          Written to <span className="font-mono text-mono-sm">{written}</span>. The app&rsquo;s dev server reloads it; commit it with the rest of your work.
        </p>
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  if (!now) return <p className="text-small text-muted">Asking the app about {name}…</p>;
  if (!now.editable || !now.found)
    return (
      <p className="text-small text-muted" data-live-edit="unavailable">
        {!now.found && now.editable ? `${name} isn't where it was on the page any more: pick it again.` : `${name} can't be edited in place: ${now.why ?? "the app didn't say why"}.`}
      </p>
    );

  const canWrite = !!target.file && !!target.line;
  return (
    <div className="space-y-3" data-live-edit="editing">
      {props.length === 0 && now.text === null && <p className="text-small text-muted">{contract ? `${name}'s contract gives no props to choose, and its text comes from code.` : `${name} isn't a design-system component, so there are no choices to offer; its text comes from code.`}</p>}
      {(props.length > 0 || now.text !== null) && (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          {props.map(([key, spec]) => {
            const value = valueOf(key, spec);
            return (
              <label key={key} className="contents">
                <span className="font-mono text-mono-sm text-muted">{key}</span>
                {spec.type === "enum" ? (
                  <Select aria-label={key} value={String(value ?? "")} onChange={(e) => change(key, e.target.value)} data-prop={key}>
                    {value === null && <option value="">(not set)</option>}
                    {spec.values.map((v) => (
                      <option key={v} value={v}>
                        {v}
                        {v === spec.default ? " (default)" : ""}
                      </option>
                    ))}
                  </Select>
                ) : spec.type === "boolean" ? (
                  <input type="checkbox" aria-label={key} className="size-3.5 justify-self-start accent-accent" checked={value === true} onChange={(e) => change(key, e.target.checked)} data-prop={key} />
                ) : (
                  <TextInput
                    aria-label={key}
                    inputMode={spec.type === "number" ? "decimal" : undefined}
                    defaultValue={value === null ? "" : String(value)}
                    onBlur={(e) => {
                      const raw = e.target.value;
                      const next = spec.type === "number" ? Number(raw) : raw;
                      if (raw !== String(value ?? "") && (spec.type !== "number" || Number.isFinite(next))) change(key, next);
                    }}
                    data-prop={key}
                  />
                )}
              </label>
            );
          })}
          {now.text !== null && (
            <label className="contents">
              <span className="font-mono text-mono-sm text-muted">text</span>
              <TextInput aria-label="text" defaultValue={now.text} maxLength={2000} onBlur={(e) => e.target.value !== (text ?? now.text) && apply(set, e.target.value)} data-prop="text" />
            </label>
          )}
        </div>
      )}
      {problem && <p className="text-small text-danger" role="alert">{problem}</p>}
      {shown && (
        <div className="space-y-2" data-live-edit="shown">
          <CodeBlock code={shown.before} title={`${shown.file}:${shown.line} now`} maxHeight="sm" />
          <CodeBlock code={shown.after} title="after" maxHeight="sm" />
        </div>
      )}
      {refused && (
        <p className="text-small text-muted" data-live-edit="refused">
          This can&rsquo;t be written for you: {refused}.
        </p>
      )}
      {!canWrite && changed && <p className="text-small text-muted">The capture found no file and line for {name}, so this can&rsquo;t be written for you.</p>}
      {error && (
        <p className="text-small text-danger" role="alert">
          {error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={!changed || busy} onClick={() => (live.reset(), setSet({}), setText(null), setShown(null), setRefused(null), setProblem(null))}>
          Reset
        </Button>
        {(refused || !canWrite) && (
          <Button size="sm" variant="outline" disabled={!changed || busy} onClick={file}>
            File as change request
          </Button>
        )}
        {canWrite && !refused && (
          <Button size="sm" variant="primary" disabled={!changed || busy} onClick={shown ? write : show}>
            {shown ? `Write to ${shown.file}` : "Write to code"}
          </Button>
        )}
      </div>
    </div>
  );
}
