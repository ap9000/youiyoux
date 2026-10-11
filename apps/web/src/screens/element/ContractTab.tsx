/** Contract: the props a component accepts, its accessibility promises, guidance and owned files. */
import { Check, ChevronRight, X } from "lucide-react";
import type { ComponentEntry, PropSpec } from "../../data/types.ts";
import { Badge } from "../../ui/Badge.tsx";
import { CodeBlock } from "../../ui/CodeBlock.tsx";
import { Facts, Section, Table } from "../../ui/Section.tsx";

function TypeCell({ spec }: { spec: PropSpec }) {
  if (spec.type !== "enum") return <span className="font-mono text-mono-sm text-ink-2">{spec.type}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {spec.values.map((value) => (
        <Badge key={value} tone={value === spec.default ? "accent" : "neutral"} className="font-mono">
          {value}
        </Badge>
      ))}
    </div>
  );
}

const defaultOf = (spec: PropSpec): string | null => ("default" in spec && spec.default !== undefined ? String(spec.default) : null);

function Guidance({ items, tone }: { items: readonly string[]; tone: "do" | "dont" }) {
  const Icon = tone === "do" ? Check : X;
  return (
    <ul className="space-y-2 rounded-md border border-line p-3">
      <li className="text-caption text-muted">{tone === "do" ? "Do" : "Don't"}</li>
      {items.map((item) => (
        <li key={item} className="flex gap-2 text-body text-ink-2">
          <Icon className={tone === "do" ? "mt-0.5 size-3.5 shrink-0 text-success" : "mt-0.5 size-3.5 shrink-0 text-danger"} />
          {item}
        </li>
      ))}
    </ul>
  );
}

export function ContractTab({ entry }: { entry: ComponentEntry }) {
  const { contract, files } = entry;
  const props = Object.entries(contract.props);
  return (
    <div className="space-y-8 p-6">
      <Section title="Props" count={props.length} aside={contract.passthrough && <span className="text-small text-muted">Other props pass through to <code className="font-mono text-ink-2">&lt;{contract.passthrough}&gt;</code></span>}>
        <Table head={["Prop", "Type", "Default", "Description"]}>
          {props.map(([name, spec]) => (
            <tr key={name}>
              <td className="font-mono text-mono whitespace-nowrap text-ink">
                {name}
                {spec.required && <span className="text-danger" aria-label="required">*</span>}
              </td>
              <td>
                <TypeCell spec={spec} />
              </td>
              <td className="font-mono text-mono-sm text-muted">{defaultOf(spec) ?? "–"}</td>
              <td className="min-w-56 text-small text-ink-2">
                {spec.description ?? ""}
                {spec.deprecated && <span className="block text-warning">Deprecated: {spec.deprecated}</span>}
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Accessibility">
          <Facts
            rows={[
              ["Role", contract.a11y.role ? <code className="font-mono text-mono">{contract.a11y.role}</code> : "–"],
              ["Touch target", contract.a11y.minTouchTarget ? `${contract.a11y.minTouchTarget}px minimum` : "–"],
            ]}
          />
          {contract.a11y.notes.length > 0 && (
            <ul className="space-y-1.5 pt-1">
              {contract.a11y.notes.map((note) => (
                <li key={note} className="flex gap-2 text-body text-ink-2">
                  <ChevronRight className="mt-1 size-3 shrink-0 text-faint" />
                  {note}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Source">
          <Facts
            rows={[
              ["Export", <code className="font-mono text-mono">{contract.source.export}</code>],
              ["Also exports", contract.source.also.length ? <code className="font-mono text-mono">{contract.source.also.join(", ")}</code> : "–"],
              ["Aliases", contract.aliases.length ? <code className="font-mono text-mono">{contract.aliases.join(", ")}</code> : "–"],
              ["File", <code className="font-mono text-mono">{contract.source.file}</code>],
            ]}
          />
        </Section>
      </div>

      {(contract.guidance.do.length > 0 || contract.guidance.dont.length > 0) && (
        <Section title="Guidance">
          <div className="grid gap-3 md:grid-cols-2">
            {contract.guidance.do.length > 0 && <Guidance items={contract.guidance.do} tone="do" />}
            {contract.guidance.dont.length > 0 && <Guidance items={contract.guidance.dont} tone="dont" />}
          </div>
        </Section>
      )}

      <Section title="Owned files" count={files.length}>
        <div className="grid gap-3">
          {files.map((file) => (
            <CodeBlock key={file.path} title={file.path} code={file.code} />
          ))}
        </div>
      </Section>
    </div>
  );
}
