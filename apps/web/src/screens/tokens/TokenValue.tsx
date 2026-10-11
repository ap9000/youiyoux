/** Renders a token's value as what it does: a colour fill, a shadow, a radius, a type specimen, a curve. */
import { clsx } from "clsx";
import type { Scheme } from "../../app/theme.tsx";
import type { Model } from "../../data/model.ts";
import type { TokenEntry } from "../../data/types.ts";

/** The system's own paper and ink for a scheme, so previews sit on the surface they were designed for. */
export interface Stage {
  readonly background: string;
  readonly ink: string;
  readonly line: string;
}

const firstToken = (model: Model, paths: readonly string[]): TokenEntry | undefined => paths.map((p) => model.tokenByPath.get(p)).find(Boolean);

export function stageFor(model: Model, scheme: Scheme): Stage {
  const paper = firstToken(model, ["color.paper", "color.surface", "color.background"]);
  const ink = firstToken(model, ["color.ink", "color.foreground", "color.text"]);
  const line = firstToken(model, ["color.line", "color.border"]);
  return {
    background: paper?.[scheme] ?? "var(--color-surface)",
    ink: ink?.[scheme] ?? "var(--color-ink)",
    line: line?.[scheme] ?? "var(--color-line)",
  };
}

/** Systems name Geist; the hub ships it as the variable webfont, so point at the loaded face first. */
export function withLoadedFonts(css: string): string {
  return css.replace(/"?Geist Mono"?(?=\s*(,|$))/g, '"Geist Mono Variable", "Geist Mono"').replace(/(^|[\s,/])"?Geist"?(?=\s*(,|$))/g, '$1"Geist Variable", Geist');
}

function Curve({ value, ink }: { value: string; ink: string }) {
  const points = /cubic-bezier\(([^)]+)\)/.exec(value)?.[1]?.split(",").map(Number);
  if (!points || points.length !== 4 || points.some((n) => !Number.isFinite(n))) return <code className="font-mono text-mono">{value}</code>;
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = points;
  const at = (x: number, y: number): string => `${x * 100},${100 - y * 100}`;
  return (
    <div className="group flex w-full flex-col items-center gap-3">
      <svg viewBox="-6 -6 112 112" className="size-24 overflow-visible" aria-label={`Easing curve ${value}`} role="img">
        <path d="M0,100 L100,0" stroke={ink} strokeOpacity="0.15" strokeDasharray="3 3" fill="none" />
        <path d={`M${at(0, 0)} L${at(x1, y1)} M${at(1, 1)} L${at(x2, y2)}`} stroke={ink} strokeOpacity="0.35" fill="none" />
        <path d={`M${at(0, 0)} C${at(x1, y1)} ${at(x2, y2)} ${at(1, 1)}`} stroke={ink} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <circle cx={x1 * 100} cy={100 - y1 * 100} r="3.5" fill={ink} />
        <circle cx={x2 * 100} cy={100 - y2 * 100} r="3.5" fill={ink} />
      </svg>
      <div className="relative h-1.5 w-28 rounded-full" style={{ background: `color-mix(in srgb, ${ink} 12%, transparent)` }}>
        <span className="absolute top-1/2 left-0 size-3 -translate-y-1/2 rounded-full transition-transform duration-700 group-hover:translate-x-26" style={{ background: ink, transitionTimingFunction: value }} />
      </div>
    </div>
  );
}

interface TokenValueProps {
  token: TokenEntry;
  scheme: Scheme;
  stage: Stage;
  className?: string;
}

/** A filled preview box for the token in one scheme. */
export function TokenValue({ token, scheme, stage, className }: TokenValueProps) {
  const value = token[scheme];
  const box = clsx("grid h-full w-full place-items-center overflow-hidden p-4", className);
  if (token.type === "color") {
    return (
      <div className={clsx("checker h-full w-full", className)}>
        <div className="h-full w-full" style={{ background: value }} />
      </div>
    );
  }
  const surface = { background: stage.background, color: stage.ink };
  switch (token.type) {
    case "shadow":
      return (
        <div className={box} style={surface}>
          <div className="h-14 w-24 rounded-lg" style={{ background: stage.background, boxShadow: value }} />
        </div>
      );
    case "dimension":
      return (
        <div className={box} style={surface}>
          {token.group === "radius" ? (
            <div className="size-16 border-2" style={{ borderRadius: value, borderColor: stage.ink }} />
          ) : (
            <div className="flex w-full items-center gap-3">
              <div className="h-3 max-w-full shrink-0 rounded-full" style={{ width: value, background: stage.ink }} />
              <span className="font-mono text-mono-sm opacity-60">{value}</span>
            </div>
          )}
        </div>
      );
    case "typography":
      return (
        <div className={clsx(box, "place-items-start content-center")} style={surface}>
          <p className="truncate" style={{ font: withLoadedFonts(value) }}>
            The quick brown fox
          </p>
        </div>
      );
    case "fontFamily":
      return (
        <div className={box} style={surface}>
          <p className="text-display" style={{ fontFamily: withLoadedFonts(value) }}>
            Aa Bb Gg 0123
          </p>
        </div>
      );
    case "cubicBezier":
      return (
        <div className={box} style={surface}>
          <Curve value={value} ink={stage.ink} />
        </div>
      );
    default:
      return (
        <div className={box} style={surface}>
          <code className="font-mono text-mono">{value}</code>
        </div>
      );
  }
}
