/** Token bindings: each role the component binds, the token it binds to, and that token's value per scheme. */
import { Link } from "wouter";
import { elementHref, shortName } from "../../data/ids.ts";
import type { Model } from "../../data/model.ts";
import type { ComponentContract, TokenEntry } from "../../data/types.ts";
import { Section, Table } from "../../ui/Section.tsx";
import { Swatch } from "../../ui/Swatch.tsx";

function Value({ token, scheme }: { token: TokenEntry; scheme: "light" | "dark" }) {
  const value = token[scheme];
  return (
    <span className="flex min-w-0 items-center gap-2">
      {token.type === "color" && <Swatch color={value} size="sm" />}
      <span className="truncate font-mono text-mono-sm text-ink-2" title={value}>
        {value}
      </span>
    </span>
  );
}

export function TokenBindings({ model, contract }: { model: Model; contract: ComponentContract }) {
  const bindings = Object.entries(contract.tokens);
  if (bindings.length === 0) return null;
  return (
    <Section title="Token bindings" count={bindings.length}>
      <Table head={["Role", "Token", "Light", "Dark"]}>
        {bindings.map(([role, id]) => {
          const token = model.tokens.get(id);
          return (
            <tr key={role}>
              <td className="font-mono text-mono whitespace-nowrap text-ink">{role}</td>
              <td className="whitespace-nowrap">
                <Link href={elementHref(id)} className="font-mono text-mono text-accent hover:underline">
                  {shortName(id)}
                </Link>
              </td>
              <td className="max-w-56">{token ? <Value token={token} scheme="light" /> : <span className="text-danger">Unknown token</span>}</td>
              <td className="max-w-56">{token && <Value token={token} scheme="dark" />}</td>
            </tr>
          );
        })}
      </Table>
    </Section>
  );
}
