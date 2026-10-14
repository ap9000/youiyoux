/** A token: light and dark values, the alias chain to its source, WCAG contrast, and who uses it. */
import { ArrowRight, Link2 } from "lucide-react";
import { Link } from "wouter";
import { type Scheme, useTheme } from "../../app/theme.tsx";
import { type ContrastGrade, contrastRatio, grade, pairsFor } from "../../data/contrast.ts";
import { elementHref, shortName, tokenHref } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import type { TokenEntry } from "../../data/types.ts";
import { Badge, type BadgeTone } from "../../ui/Badge.tsx";
import { CopyButton } from "../../ui/CopyButton.tsx";
import { KindIcon } from "../../ui/KindIcon.tsx";
import { Section, Table } from "../../ui/Section.tsx";
import { stageFor, TokenValue } from "./TokenValue.tsx";

const SCHEMES: readonly Scheme[] = ["light", "dark"];
const GRADE_TONE: Record<ContrastGrade, BadgeTone> = { AAA: "success", AA: "success", "AA large": "warning", Fail: "danger" };

export interface ContrastPair {
  readonly label: string;
  readonly foreground: TokenEntry;
  readonly background: TokenEntry;
}

/**
 * Which pairs matter for a colour (the shared pair finder the style editor and its impact
 * preview use): `on-x` sits on `x`; `x-soft` carries `x` text; a surface carries ink and
 * muted; anything else is read as text on the system's surfaces.
 */
export function contrastPairs(model: Model, token: TokenEntry): ContrastPair[] {
  const tokens = [...model.tokens.values()].map((t) => ({ path: t.path, type: t.type, light: t.light, dark: t.dark }));
  return pairsFor(tokens, token.path).map((pair) => ({ label: pair.label, foreground: model.tokenByPath.get(pair.foreground)!, background: model.tokenByPath.get(pair.background)! }));
}

function Ratio({ fg, bg }: { fg: string; bg: string }) {
  const ratio = contrastRatio(fg, bg);
  if (ratio === null) return <span className="text-muted">–</span>;
  const g = grade(ratio);
  return (
    <span className="flex items-center gap-2">
      <span className="flex items-center gap-1" aria-hidden>
        <span className="edge grid size-6 place-items-center rounded-xs text-caption font-semibold" style={{ background: bg, color: fg }}>
          Aa
        </span>
      </span>
      <span className="tabular w-12 font-mono text-mono-sm text-ink">{ratio.toFixed(2)}</span>
      <Badge tone={GRADE_TONE[g]}>{g}</Badge>
    </span>
  );
}

function ValueCard({ model, token, scheme }: { model: Model; token: TokenEntry; scheme: Scheme }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="h-32 border-b border-line">
        <TokenValue token={token} scheme={scheme} stage={stageFor(model, scheme)} />
      </div>
      <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
        <span className="w-10 text-small text-muted capitalize">{scheme}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-mono text-ink" title={token[scheme]}>
          {token[scheme]}
        </code>
        <CopyButton value={token[scheme]} label={`Copy ${scheme} value`} />
      </div>
    </div>
  );
}

function AliasChain({ model, token }: { model: Model; token: TokenEntry }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {token.aliasChain.map((id, i) => {
        const link = model.tokens.get(id);
        const last = i === token.aliasChain.length - 1;
        return (
          <li key={id} className="flex items-center gap-1.5">
            {i > 0 && <ArrowRight aria-hidden className="size-3.5 text-faint" />}
            {i === 0 ? (
              <span className="rounded-sm border border-line bg-raised px-2 py-0.5 font-mono text-mono text-ink">{token.path}</span>
            ) : (
              <Link href={link ? tokenHref(link.path) : "#"} className="rounded-sm border border-line px-2 py-0.5 font-mono text-mono text-accent hover:bg-raised">
                {shortName(id)}
              </Link>
            )}
            {last && i > 0 && <span className="text-small text-muted">holds the value</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function TokenDetail({ model, token }: { model: Model; token: TokenEntry }) {
  const element = model.byId.get(token.id);
  const { scheme } = useTheme();
  const consumers = model.tokenConsumers.get(token.id) ?? [];
  const aliasedBy = [...model.tokens.values()].filter((t) => t.aliasChain.indexOf(token.id) > 0);
  const pairs = contrastPairs(model, token);
  const isAlias = token.aliasChain.length > 1;

  return (
    <article className="min-h-0 flex-1 overflow-y-auto animate-enter">
      <header className="border-b border-line px-6 pt-5 pb-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised">{element && <KindIcon element={element} scheme={scheme} className="size-4" />}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 data-detail-heading tabIndex={-1} className="truncate font-mono text-title outline-none">
                {token.path}
              </h2>
              <Badge tone="outline">{token.type}</Badge>
              {isAlias && (
                <Badge tone="neutral">
                  <Link2 /> alias
                </Badge>
              )}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 font-mono text-mono-sm text-muted">
              <span className="flex items-center gap-0.5">
                {token.cssVar}
                <CopyButton value={`var(${token.cssVar})`} label="Copy CSS variable" />
              </span>
              <span className="flex min-w-0 items-center gap-0.5">
                <span className="truncate">{token.id}</span>
                <CopyButton value={token.id} label="Copy element id" />
              </span>
            </div>
          </div>
        </div>
        {token.description && <p className="mt-3 max-w-2xl text-reading text-ink-2">{token.description}</p>}
      </header>
      <div className="space-y-8 p-6">
        <Section title="Values">
          <div className="grid gap-3 sm:grid-cols-2">
            {SCHEMES.map((scheme) => (
              <ValueCard key={scheme} model={model} token={token} scheme={scheme} />
            ))}
          </div>
        </Section>
        {isAlias && (
          <Section title="Alias chain">
            <AliasChain model={model} token={token} />
          </Section>
        )}
        {pairs.length > 0 && (
          <Section title="Contrast" aside={<span className="text-small text-muted">WCAG 2: 4.5 for body text, 3 for large text and UI parts</span>}>
            <Table head={["Pair", "Light", "Dark"]}>
              {pairs.map((pair) => (
                <tr key={pair.label}>
                  <td className="text-body whitespace-nowrap text-ink-2">{pair.label}</td>
                  {SCHEMES.map((scheme) => (
                    <td key={scheme}>
                      <Ratio fg={pair.foreground[scheme]} bg={pair.background[scheme]} />
                    </td>
                  ))}
                </tr>
              ))}
            </Table>
          </Section>
        )}
        <Section title="Declared consumers" count={consumers.length + aliasedBy.length}>
          <p className="mb-2 text-small text-muted">
            Contract bindings and aliases only. Code that uses the CSS variable or its Tailwind utilities directly is not counted here: <code className="font-mono text-mono-sm">youiyoux plan --token {token.path}</code> finds those uses in a project.
          </p>
          {consumers.length + aliasedBy.length === 0 ? (
            <p className="text-body text-muted">No component contract binds this token, and no token aliases it.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {consumers.map(({ component, role }) => (
                <li key={`${component}:${role}`} className="flex h-9 items-center gap-3 px-3">
                  <Link href={elementHref(component, "contract")} className="font-medium text-ink hover:underline">
                    {model.byId.get(component)?.name ?? component}
                  </Link>
                  <span className="font-mono text-mono-sm text-muted">{role}</span>
                </li>
              ))}
              {aliasedBy.map((alias) => (
                <li key={alias.id} className="flex h-9 items-center gap-3 px-3">
                  <Link href={tokenHref(alias.path)} className="font-mono text-mono text-ink hover:underline">
                    {alias.path}
                  </Link>
                  <span className="text-small text-muted">aliases this token</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </article>
  );
}
