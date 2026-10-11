/** The rule form: what people read, what agents follow, how hard it bites, and how it is checked. */
import { Plus, X } from "lucide-react";
import type { CheckCapability, DraftContent, RuleFields, WorkflowInfo } from "../../data/workflow.ts";
import { Button } from "../../ui/Button.tsx";
import { Checkbox, Field, Select, TextArea, TextInput } from "../../ui/Field.tsx";
import { Section } from "../../ui/Section.tsx";
import { Segmented } from "../../ui/Segmented.tsx";

interface RuleFormProps {
  value: DraftContent;
  onChange: (value: DraftContent) => void;
  info: WorkflowInfo;
  mode: "edit" | "create";
  readOnly: boolean;
  problems: readonly string[];
}

type Check = RuleFields["check"];
type YouiCheck = Extract<Check, { engine: "youi" }>;
type NativeOptions = { elements: Record<string, string>; allowInputTypes: string[] };

const SEVERITIES = [
  { value: "error" as const, label: "Error" },
  { value: "warn" as const, label: "Warning" },
  { value: "off" as const, label: "Off" },
];

const NATIVE_TAGS = ["button", "input", "textarea", "select", "a", "label", "dialog"];

/** The first problem the service reported for a field (`field: message`). */
function problemFor(problems: readonly string[], field: string): string | undefined {
  const hit = problems.find((p) => p.startsWith(`${field}:`) || p.startsWith(`${field}.`));
  return hit?.slice(hit.indexOf(":") + 1).trim();
}

const lines = (text: string): string[] => text.split("\n");
const slug = (title: string): string => title.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
const checkKey = (check: Check): string => (check.engine === "youi" ? check.id : check.engine);

function checkFor(key: string, capabilities: readonly CheckCapability[]): Check {
  const capability = capabilities.find((c) => (c.id ?? c.engine) === key);
  if (!capability || capability.engine === "advisory") return { engine: "advisory" };
  return { engine: "youi", id: capability.id as YouiCheck["id"], options: { ...capability.defaults } };
}

export function RuleForm({ value, onChange, info, mode, readOnly, problems }: RuleFormProps) {
  const rule = value.rule;
  const set = (patch: Partial<RuleFields>): void => onChange({ ...value, rule: { ...rule, ...patch } });
  const prefix = `youi:${info.project.system}/rule/`;
  const name = rule.id.startsWith(prefix) ? rule.id.slice(prefix.length) : rule.id;
  const capability = info.checks.find((c) => (c.id ?? c.engine) === checkKey(rule.check));
  const error = (field: string): string | undefined => problemFor(problems, field);

  const onTitle = (title: string): void => {
    // A new rule's id follows its title until someone types an id of their own.
    const followsTitle = mode === "create" && (name === "" || name === slug(rule.title));
    set({ title, ...(followsTitle ? { id: `${prefix}${slug(title)}` } : {}) });
  };

  return (
    <fieldset disabled={readOnly} className="min-w-0 space-y-8">
      <Section title="What it says">
        <div className="space-y-4">
          <Field label="Title" error={error("title")}>
            {(id, describedBy) => <TextInput id={id} aria-describedby={describedBy} value={rule.title} placeholder="Use the owned Select, not a native select" onChange={(e) => onTitle(e.target.value)} />}
          </Field>
          <Field label="Rule id" error={error("id")} hint={mode === "edit" ? "An existing rule keeps its id." : "Lowercase words joined by dots or dashes, e.g. components.no-native-select."}>
            {(id, describedBy) => (
              <div className="flex items-center rounded-md border border-line bg-sunken font-mono text-mono-sm">
                <span className="shrink-0 pl-2.5 text-muted">{prefix}</span>
                <TextInput id={id} aria-describedby={describedBy} value={name} readOnly={mode === "edit"} onChange={(e) => set({ id: `${prefix}${e.target.value.trim()}` })} className="h-8 border-0 bg-transparent pl-0 font-mono text-mono-sm" />
              </div>
            )}
          </Field>
          <Field label="Statement" hint="The rule, for people: one or two sentences." error={error("statement")}>
            {(id, describedBy) => <TextArea id={id} aria-describedby={describedBy} value={rule.statement} onChange={(e) => set({ statement: e.target.value })} />}
          </Field>
          <Field label="Why" hint="What goes wrong without it. Reviewers and agents read this when the rule seems inconvenient." error={error("rationale")}>
            {(id, describedBy) => <TextArea id={id} aria-describedby={describedBy} value={rule.rationale} onChange={(e) => set({ rationale: e.target.value })} />}
          </Field>
          <Field label="Instruction for agents" hint="One imperative line. Agents get it from youi_get_rules and the AGENTS.md block." error={error("agent")}>
            {(id, describedBy) => <TextArea id={id} aria-describedby={describedBy} rows={2} value={rule.agent} placeholder="Never render a native <select>; use <Select> from the components directory." onChange={(e) => set({ agent: e.target.value })} />}
          </Field>
        </div>
      </Section>

      <Section title="How hard it bites">
        <div className="space-y-3">
          <Segmented label="Severity" value={rule.severity} options={SEVERITIES} onChange={(severity) => set({ severity, ...(severity === "warn" ? {} : { rollout: null }) })} />
          <p className="text-small text-muted">{rule.severity === "error" ? "Fails youi check." : rule.severity === "warn" ? "Reported by youi check; never fails it." : "Published, but never checked."}</p>
          {rule.severity === "warn" && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-line bg-sunken px-3 py-2.5">
              <Checkbox label="Plan to tighten it to an error" checked={rule.rollout !== null} onChange={(e) => set({ rollout: e.target.checked ? { to: "error" } : null })} />
              {rule.rollout && (
                <label className="flex items-center gap-2 text-small text-muted">
                  after
                  <TextInput type="date" value={rule.rollout.after ?? ""} onChange={(e) => set({ rollout: { to: "error", ...(e.target.value ? { after: e.target.value } : {}), ...(rule.rollout?.note ? { note: rule.rollout.note } : {}) } })} className="h-7 w-auto" />
                </label>
              )}
              <p className="w-full text-small text-muted">Warn first, then tighten. Tightening is its own reviewed change, made from this rule once the places it flags are fixed.</p>
            </div>
          )}
          {error("severity") && <p className="text-small text-danger">{error("severity")}</p>}
        </div>
      </Section>

      <Section title="How it is checked">
        <div className="space-y-4">
          <Field label="Check" hint={capability?.description ?? "This check cannot run here yet; pick one that can."} error={error("check")}>
            {(id, describedBy) => (
              <Select id={id} aria-describedby={describedBy} value={capability ? checkKey(rule.check) : "unsupported"} onChange={(e) => set({ check: checkFor(e.target.value, info.checks) })}>
                {!capability && <option value="unsupported">Custom check (cannot run yet)</option>}
                {info.checks.map((c) => (
                  <option key={c.id ?? c.engine} value={c.id ?? c.engine}>
                    {c.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {capability?.options === "native-elements" && rule.check.engine === "youi" && (
            <NativeElements options={rule.check.options as Partial<NativeOptions>} info={info} onChange={(options) => set({ check: { ...(rule.check as YouiCheck), options } })} />
          )}
          <Field label="Files" hint="Globs, one per line, relative to the project root." error={error("files")}>
            {(id, describedBy) => <TextArea id={id} aria-describedby={describedBy} rows={2} value={rule.files.join("\n")} onChange={(e) => set({ files: lines(e.target.value) })} className="font-mono text-mono-sm" />}
          </Field>
        </div>
      </Section>

      <Section title="Examples">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Breaks the rule" hint="One example per line." error={error("examples")}>
            {(id, describedBy) => <TextArea id={id} aria-describedby={describedBy} rows={4} value={rule.examples.bad.join("\n")} onChange={(e) => set({ examples: { ...rule.examples, bad: lines(e.target.value) } })} className="font-mono text-mono-sm" />}
          </Field>
          <Field label="Follows the rule" hint="One example per line.">
            {(id, describedBy) => <TextArea id={id} aria-describedby={describedBy} rows={4} value={rule.examples.good.join("\n")} onChange={(e) => set({ examples: { ...rule.examples, good: lines(e.target.value) } })} className="font-mono text-mono-sm" />}
          </Field>
        </div>
      </Section>

      <Section title="Components that follow it" count={value.components.length}>
        <p className="text-small text-muted">Listed on each component's Rules tab. The check runs on every matching file either way.</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {info.components.map((c) => (
            <Checkbox
              key={c.id}
              label={c.name}
              checked={value.components.includes(c.id)}
              onChange={(e) => onChange({ ...value, components: e.target.checked ? [...value.components, c.id] : value.components.filter((id) => id !== c.id) })}
            />
          ))}
        </div>
        {error("components") && <p className="text-small text-danger">{error("components")}</p>}
      </Section>
    </fieldset>
  );
}

function NativeElements({ options, info, onChange }: { options: Partial<NativeOptions>; info: WorkflowInfo; onChange: (options: NativeOptions) => void }) {
  const elements = options.elements ?? {};
  const allow = options.allowInputTypes ?? [];
  const rows = Object.entries(elements);
  const update = (next: Record<string, string>, types = allow): void => onChange({ elements: next, allowInputTypes: types });
  const free = NATIVE_TAGS.find((tag) => !(tag in elements));
  const first = info.components[0];
  return (
    <div className="space-y-2.5 rounded-md border border-line p-3">
      <p className="text-small font-medium text-ink-2">Native tag → the component to render instead</p>
      {rows.length === 0 && <p className="text-small text-muted">No tags yet: this check flags nothing until you add one.</p>}
      {rows.map(([tag, component]) => (
        <div key={tag} className="flex items-center gap-2">
          <div className="w-36 shrink-0">
            <Select aria-label="Native tag" value={tag} className="font-mono text-mono-sm" onChange={(e) => update(Object.fromEntries(rows.map(([t, c]) => (t === tag ? [e.target.value, c] : [t, c]))))}>
              {NATIVE_TAGS.filter((t) => t === tag || !(t in elements)).map((t) => (
                <option key={t} value={t}>{`<${t}>`}</option>
              ))}
            </Select>
          </div>
          <span className="text-muted">→</span>
          <div className="min-w-0 flex-1">
            <Select aria-label={`Component for <${tag}>`} value={component} onChange={(e) => update({ ...elements, [tag]: e.target.value })}>
              {info.components.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="ghost" size="icon" aria-label={`Remove <${tag}>`} onClick={() => update(Object.fromEntries(rows.filter(([t]) => t !== tag)))}>
            <X />
          </Button>
        </div>
      ))}
      {free && first && (
        <Button size="sm" onClick={() => update({ ...elements, [free]: first.id })}>
          <Plus /> Add a tag
        </Button>
      )}
      <Field label="Input types that stay native" hint="Comma-separated, e.g. hidden, checkbox, file. Applied when the field loses focus.">
        {(id, describedBy) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            key={allow.join(",")}
            defaultValue={allow.join(", ")}
            onBlur={(e) => update(elements, e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
            className="font-mono text-mono-sm"
          />
        )}
      </Field>
    </div>
  );
}
