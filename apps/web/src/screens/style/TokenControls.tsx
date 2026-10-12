/**
 * One token in the style editor: its value per scheme, with a control for its type. Any value,
 * or any part of a composite (a typography's family, a focus ring's colour), may be its own or
 * an alias of another token of that type. Dark follows light until the token is given its own.
 */
import { clsx } from "clsx";
import { Minus, Moon, Plus, TriangleAlert } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { criticalDamping, FAMILY_NAME, resolveAliases, springCurve, type Spring } from "@youiyoux/tokens/values";
import type { DtcgColor } from "@youiyoux/tokens/color";
import type { TokenEntry } from "../../data/types.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Button } from "../../ui/Button.tsx";
import { AliasSelect, bezierPoints, ChoiceField, ColorField, CurvePlot, INPUT, NumberField, ResetButton, Row } from "./fields.tsx";
import { aliasOf, cssOf, editOf, hasOwnDark, sourceOf, type ContrastWarning, type EditAction, type EditorModel, type Scheme } from "./model.ts";
import type { StyleDraftContent } from "@youiyoux/workflow/api";

type Dimension = { value: number; unit: string };

/** What an aliased token shows now, with the unsaved edits (per scheme of the value being edited). */
const Shown = createContext<(path: string) => string>(() => "");
type Bezier = [number, number, number, number];

/** Types whose dark value commonly differs: they offer "Different in dark". */
const SCHEMED = new Set(["color", "shadow", "border", "focusRing", "gradient"]);
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const LINE_STYLES = ["solid", "dashed", "dotted", "double"];
const EASINGS: ReadonlyArray<readonly [string, Bezier]> = [
  ["ease", [0.25, 0.1, 0.25, 1]],
  ["ease-in", [0.42, 0, 1, 1]],
  ["ease-out", [0, 0, 0.58, 1]],
  ["ease-in-out", [0.42, 0, 0.58, 1]],
];

interface EditorProps {
  model: EditorModel;
  /** The token type this value has. */
  type: string;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  /** Excluded from alias choices (a token cannot alias itself). */
  self?: string;
  compact?: boolean;
}

const aliasOptions = (model: EditorModel, type: string, self?: string): string[] => model.tokens.filter((t) => t.type === type && t.path !== self && t.source).map((t) => t.path);

/** A value of any type: its own (with the type's control) or an alias. */
function ValueEditor({ model, type, value, onChange, label, self, compact }: EditorProps) {
  const alias = aliasOf(value);
  const options = aliasOptions(model, type, self);
  const target = alias ? model.byPath.get(alias) : undefined;
  const shown = useContext(Shown);
  // Detaching starts from the value the alias shows now (light).
  const own = (): unknown => resolveAliases(value, (path) => model.byPath.get(path)?.source?.light);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      {(options.length > 0 || alias) && <AliasSelect label={`${label}: own value or alias`} value={alias} options={options} onChange={(next) => onChange(next ? `{${next}}` : own())} />}
      {alias ? <span className="truncate font-mono text-mono-sm text-muted">{target ? shown(target.path) || target.light : "unknown token"}</span> : <OwnValue model={model} type={type} value={value} onChange={onChange} label={label} compact={compact} {...(self ? { self } : {})} />}
    </span>
  );
}

function DimensionField({ label, value, onChange, step = 1, units = ["px", "rem"] }: { label: string; value: Dimension; onChange: (value: Dimension) => void; step?: number; units?: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      <NumberField label={label} value={value.value} step={value.unit === "rem" || value.unit === "s" ? step / 10 : step} onChange={(n) => onChange({ ...value, value: n })} />
      <ChoiceField label={`${label} unit`} value={value.unit} options={units} onChange={(unit) => onChange({ ...value, unit })} />
    </span>
  );
}

function OwnValue({ model, type, value, onChange, label, compact }: EditorProps) {
  switch (type) {
    case "color":
      return typeof value === "object" && value !== null ? <ColorField label={label} value={value as DtcgColor} onChange={onChange} /> : <Unsupported value={value} />;
    case "dimension":
      return <DimensionField label={label} value={value as Dimension} onChange={onChange} />;
    case "duration":
      return <DimensionField label={label} value={value as Dimension} onChange={onChange} step={10} units={["ms", "s"]} />;
    case "number": {
      const n = value as number;
      return <NumberField label={label} value={n} step={Math.abs(n) <= 1 ? 0.05 : 1} onChange={onChange} />;
    }
    case "fontWeight":
      return <ChoiceField label={label} value={value as number} options={WEIGHTS.includes(value as number) ? WEIGHTS : [...WEIGHTS, value as number]} onChange={onChange} />;
    case "fontFamily":
      return <FamilyField label={label} value={Array.isArray(value) ? (value as string[]) : [String(value)]} onChange={onChange} />;
    case "strokeStyle":
      return typeof value === "string" ? <ChoiceField label={label} value={value} options={LINE_STYLES.includes(value) ? LINE_STYLES : [...LINE_STYLES, value]} onChange={onChange} /> : <Unsupported value={value} />;
    case "cubicBezier":
      return <BezierEditor label={label} value={value as Bezier} onChange={onChange} />;
    case "spring":
      return <SpringEditor label={label} value={value as Spring} onChange={onChange} />;
    case "typography":
    case "border":
    case "transition":
    case "focusRing":
      return <Parts model={model} type={type} value={value as Record<string, unknown>} onChange={onChange} label={label} compact={compact} />;
    case "shadow":
      return <ShadowEditor model={model} value={value} onChange={onChange} label={label} />;
    default:
      return <Unsupported value={value} />;
  }
}

/** A font stack, typed as a comma-separated list. */
function FamilyField({ label, value, onChange }: { label: string; value: readonly string[]; onChange: (value: string[]) => void }) {
  const joined = value.join(", ");
  const [text, setText] = useState(joined);
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  const noteId = useId();
  useEffect(() => {
    if (!focused.current) setText(joined);
  }, [joined]);
  return (
    <span className="inline-flex max-w-full flex-col gap-1">
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? noteId : undefined}
        value={text}
        spellCheck={false}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          setText(joined);
          setInvalid(false);
        }}
        onChange={(event) => {
          setText(event.target.value);
          const families = event.target.value.split(",").map((f) => f.trim()).filter(Boolean);
          // The token schema refuses anything else (quotes, semicolons, braces…): such a name is never applied.
          const ok = families.length > 0 && families.every((f) => FAMILY_NAME.test(f));
          setInvalid(!ok && event.target.value.trim() !== "");
          if (ok) onChange(families);
        }}
        className={clsx(INPUT, "h-7 w-[16rem] max-w-full", invalid && "border-danger")}
      />
      {invalid && (
        <span id={noteId} className="text-caption text-danger">
          Letters, digits, spaces and hyphens only; separate families with commas.
        </span>
      )}
    </span>
  );
}

function Unsupported({ value }: { value: unknown }) {
  return <code className="truncate font-mono text-mono-sm text-muted">{JSON.stringify(value)}</code>;
}

/** The parts of a composite, each its own value or an alias. */
const PARTS: Readonly<Record<string, ReadonlyArray<readonly [key: string, type: string, label: string]>>> = {
  typography: [
    ["fontFamily", "fontFamily", "Family"],
    ["fontSize", "dimension", "Size"],
    ["fontWeight", "fontWeight", "Weight"],
    ["lineHeight", "number", "Line height"],
    ["letterSpacing", "dimension", "Tracking"],
  ],
  border: [
    ["color", "color", "Colour"],
    ["width", "dimension", "Width"],
    ["style", "strokeStyle", "Style"],
  ],
  transition: [
    ["duration", "duration", "Duration"],
    ["delay", "duration", "Delay"],
    ["timingFunction", "cubicBezier", "Easing"],
  ],
  focusRing: [
    ["color", "color", "Colour"],
    ["width", "dimension", "Width"],
    ["offset", "dimension", "Offset"],
    ["style", "strokeStyle", "Style"],
  ],
};

function Parts({ model, type, value, onChange, label }: EditorProps & { value: Record<string, unknown> }) {
  return (
    <div className="grid w-full gap-1.5">
      {(PARTS[type] ?? []).map(([key, partType, partLabel]) => {
        const part = value[key];
        // A line height written as a dimension is edited as one.
        const effective = key === "lineHeight" && typeof part === "object" && part !== null ? "dimension" : partType;
        if (part === undefined) {
          if (key !== "letterSpacing") return null;
          return (
            <Row key={key} label={partLabel}>
              <Button size="sm" variant="ghost" onClick={() => onChange({ ...value, letterSpacing: { value: 0, unit: "px" } })}>
                <Plus /> Add tracking
              </Button>
            </Row>
          );
        }
        return (
          <Row key={key} label={partLabel}>
            <ValueEditor model={model} type={effective} value={part} label={`${label} ${partLabel.toLowerCase()}`} onChange={(next) => onChange({ ...value, [key]: next })} compact />
          </Row>
        );
      })}
    </div>
  );
}

function BezierEditor({ label, value, onChange }: { label: string; value: Bezier; onChange: (value: Bezier) => void }) {
  const names = ["x1", "y1", "x2", "y2"];
  const preset = EASINGS.find(([, curve]) => curve.every((n, i) => n === value[i]))?.[0] ?? "custom";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <CurvePlot points={bezierPoints(value)} label={`${label}: cubic-bezier(${value.join(", ")})`} />
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {value.map((n, i) => (
          // A visible name per control point coordinate; the input's accessible name still carries the token's.
          <label key={names[i]} className="inline-flex items-center gap-1">
            <span aria-hidden className="w-4 font-mono text-mono-sm text-muted">
              {names[i]}
            </span>
            <NumberField label={`${label} ${names[i]}`} value={n} step={0.01} {...(i % 2 === 0 ? { min: 0, max: 1 } : {})} onChange={(next) => onChange(value.map((v, j) => (j === i ? next : v)) as Bezier)} />
          </label>
        ))}
      </div>
      <ChoiceField label={`${label} preset`} value={preset} options={["custom", ...EASINGS.map(([name]) => name)]} onChange={(name) => {
        const curve = EASINGS.find(([n]) => n === name)?.[1];
        if (curve) onChange([...curve] as Bezier);
      }} />
    </div>
  );
}

function SpringEditor({ label, value, onChange }: { label: string; value: Spring; onChange: (value: Spring) => void }) {
  const curve = springCurve(value);
  const critical = criticalDamping(value);
  const set = (key: keyof Spring) => (n: number) => onChange({ ...value, [key]: n });
  return (
    <div className="grid w-full gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <CurvePlot points={curve.points} label={`${label}: settle curve, ${curve.durationMs} ms`} />
        <p className="text-small text-muted">
          {curve.settles ? (
            <>
              Settles in <span className="tabular text-ink">{curve.durationMs} ms</span>
            </>
          ) : (
            <span className="text-warning">Never settles: add damping</span>
          )}
          <br />
          {value.damping < critical ? `Overshoots (critical damping ≈ ${critical.toFixed(1)})` : "No overshoot"}
        </p>
      </div>
      <Row label="Stiffness">
        <NumberField label={`${label} stiffness`} value={value.stiffness} step={10} min={1} onChange={set("stiffness")} />
      </Row>
      <Row label="Damping">
        <NumberField label={`${label} damping`} value={value.damping} step={1} min={0} onChange={set("damping")} />
      </Row>
      <Row label="Mass">
        <NumberField label={`${label} mass`} value={value.mass} step={0.1} min={0.1} onChange={set("mass")} />
      </Row>
      <Row label="Velocity">
        <NumberField label={`${label} velocity`} value={value.velocity ?? 0} step={0.1} onChange={(n) => onChange(n === 0 ? { stiffness: value.stiffness, damping: value.damping, mass: value.mass } : { ...value, velocity: n })} />
      </Row>
    </div>
  );
}

type Layer = { color: unknown; offsetX: unknown; offsetY: unknown; blur: unknown; spread: unknown; inset?: boolean };

function ShadowEditor({ model, value, onChange, label }: { model: EditorModel; value: unknown; onChange: (value: unknown) => void; label: string }) {
  const layers = (Array.isArray(value) ? value : [value]) as Layer[];
  const set = (index: number, next: Layer): void => onChange(layers.map((l, i) => (i === index ? next : l)));
  return (
    <div className="grid w-full gap-2">
      {layers.map((layer, index) => (
        <fieldset key={index} className="grid gap-1.5 rounded-md border border-line p-2">
          <legend className="px-1 text-caption text-muted">Layer {index + 1}</legend>
          <Row label="Colour">
            <ValueEditor model={model} type="color" value={layer.color} label={`${label} layer ${index + 1} colour`} onChange={(color) => set(index, { ...layer, color })} compact />
          </Row>
          <Row label="x, y">
            <ValueEditor model={model} type="dimension" value={layer.offsetX} label={`${label} layer ${index + 1} x`} onChange={(offsetX) => set(index, { ...layer, offsetX })} compact />
            <ValueEditor model={model} type="dimension" value={layer.offsetY} label={`${label} layer ${index + 1} y`} onChange={(offsetY) => set(index, { ...layer, offsetY })} compact />
          </Row>
          <Row label="Blur, spread">
            <ValueEditor model={model} type="dimension" value={layer.blur} label={`${label} layer ${index + 1} blur`} onChange={(blur) => set(index, { ...layer, blur })} compact />
            <ValueEditor model={model} type="dimension" value={layer.spread} label={`${label} layer ${index + 1} spread`} onChange={(spread) => set(index, { ...layer, spread })} compact />
          </Row>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-small text-ink-2">
              <input type="checkbox" className="size-3.5 accent-accent" checked={layer.inset === true} onChange={(event) => set(index, event.target.checked ? { ...layer, inset: true } : (({ inset: _inset, ...rest }) => rest)(layer))} /> Inset
            </label>
            {layers.length > 1 && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onChange(layers.filter((_, i) => i !== index))}>
                <Minus /> Remove layer
              </Button>
            )}
          </div>
        </fieldset>
      ))}
      <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => onChange([...layers, { ...layers.at(-1)! }])}>
        <Plus /> Add layer
      </Button>
    </div>
  );
}

/** The ratio and grade of each colour pair below AA that this token is part of. */
function Warnings({ warnings }: { warnings: readonly ContrastWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-md bg-warning-soft px-2.5 py-1.5">
      {warnings.map((w) => (
        <li key={`${w.pair.key}|${w.scheme}`} className="flex items-start gap-1.5 text-small text-ink-2">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            {w.pair.label} ({w.scheme}): {w.ratio === null ? <span className="font-medium">{w.unreadable}</span> : <span className="tabular font-medium">{w.ratio.toFixed(2)}:1</span>}, needs {w.required}:1{w.isNew ? "" : " (already below before these edits)"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TokenCard({ model, token, content, dispatch, warnings }: { model: EditorModel; token: TokenEntry; content: StyleDraftContent; dispatch: (action: EditAction) => void; warnings: readonly ContrastWarning[] }) {
  const edit = editOf(content, token.path);
  const ownDark = hasOwnDark(token, edit);
  const headingId = useId();
  const scheme = (s: Scheme): ReactNode => (
    <Shown.Provider value={(path) => cssOf(model, content, path, s)}>
      <ValueEditor model={model} type={token.type} value={sourceOf(model, content, token.path, s)} label={`${token.path} ${s}`} self={token.path} onChange={(value) => dispatch({ type: "token", path: token.path, scheme: s, value })} />
    </Shown.Provider>
  );
  return (
    <section aria-labelledby={headingId} data-token={token.path} className={clsx("space-y-2.5 rounded-lg border p-3", edit ? "border-accent/40 bg-accent-soft/30" : "border-line")}>
      <header className="flex min-w-0 items-center gap-2">
        <h3 id={headingId} className="min-w-0 truncate font-mono text-mono text-ink">
          {token.path}
        </h3>
        <Badge tone="outline">{token.type}</Badge>
        {edit && (
          <>
            <Badge tone="accent">Edited</Badge>
            <span className="ml-auto">
              <ResetButton label={`Reset ${token.path}`} onClick={() => dispatch({ type: "reset-token", path: token.path })} />
            </span>
          </>
        )}
      </header>
      {token.description && <p className="text-small text-muted">{token.description}</p>}
      <div className="space-y-2">
        <SchemeRow label={ownDark ? "Light" : SCHEMED.has(token.type) ? "Light & dark" : "Value"}>{scheme("light")}</SchemeRow>
        {ownDark ? (
          <SchemeRow
            label="Dark"
            action={
              <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "dark-follows", path: token.path })}>
                Follow light
              </Button>
            }
          >
            {scheme("dark")}
          </SchemeRow>
        ) : (
          SCHEMED.has(token.type) && (
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "dark-own", path: token.path })}>
              <Moon /> Different in dark
            </Button>
          )
        )}
      </div>
      <Warnings warnings={warnings} />
    </section>
  );
}

function SchemeRow({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-caption text-muted">{label}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
