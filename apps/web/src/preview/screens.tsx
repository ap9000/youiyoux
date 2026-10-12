/**
 * Representative screens for the style editor: every component together, then specimens that
 * read each token's CSS variable (type and colour, space and shape, motion, focus). They use
 * only `var(--…)`, so an override from the editor shows on the next frame.
 */
import { type ComponentType, type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { ensurePinned } from "./pin.ts";
import type { PreviewScreen, PreviewToken } from "./protocol.ts";

type DemoModule = { default: ComponentType };
export type Demos = Readonly<Record<string, () => Promise<DemoModule>>>;

const v = (token: PreviewToken, suffix = ""): string => `var(${token.cssVar}${suffix})`;
const name = (token: PreviewToken): string => token.path;
const of = (tokens: readonly PreviewToken[], ...types: string[]): PreviewToken[] => tokens.filter((t) => types.includes(t.type));

/** Colour paths that read as surfaces and as text, by the names systems give them. */
const SURFACE = /(?:^|\.)(?:paper|ground|raised|surface|canvas|background|card|sunken)$/;
const TEXT = /(?:^|[.-])(?:ink|text|foreground|fg|muted|subtle|faint)(?:-\d)?$/;

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 32 }}>
      <h2 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", opacity: 0.6 }}>{title}</h2>
      {children}
    </section>
  );
}

const Label = ({ children }: { children: ReactNode }) => <code style={{ fontSize: 11, opacity: 0.7 }}>{children}</code>;

function useDemos(demos: Demos): Array<[string, ComponentType]> {
  const [loaded, setLoaded] = useState<Array<[string, ComponentType]>>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(Object.entries(demos).map(async ([key, load]) => [key, (await load()).default] as [string, ComponentType])).then((all) => live && setLoaded(all));
    return () => {
      live = false;
    };
  }, [demos]);
  return loaded;
}

function AllComponents({ demos }: { demos: Demos }) {
  const loaded = useDemos(demos);
  return (
    <>
      {loaded.map(([key, Demo]) => (
        <Block key={key} title={key}>
          <Demo />
        </Block>
      ))}
    </>
  );
}

function TypeAndColour({ tokens }: { tokens: readonly PreviewToken[] }) {
  const colours = of(tokens, "color");
  const surfaces = colours.filter((t) => SURFACE.test(t.path));
  const texts = colours.filter((t) => TEXT.test(t.path));
  return (
    <>
      <Block title="Type">
        {of(tokens, "typography").map((t) => (
          <div key={t.path} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Label>{name(t)}</Label>
            <p style={{ margin: 0, font: v(t), letterSpacing: v(t, "-letter-spacing") }}>Ship the change once everyone can read it.</p>
          </div>
        ))}
      </Block>
      <Block title="Text on surfaces">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
          {surfaces.map((bg) => (
            <div key={bg.path} style={{ background: v(bg), borderRadius: 8, padding: 12, boxShadow: "inset 0 0 0 1px rgb(127 127 127 / .25)" }}>
              <Label>{name(bg)}</Label>
              {texts.map((fg) => (
                <p key={fg.path} style={{ margin: "4px 0 0", color: v(fg), fontSize: 13 }}>
                  {fg.path.split(".").at(-1)} text
                </p>
              ))}
            </div>
          ))}
        </div>
      </Block>
      <Block title="Colour">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8 }}>
          {colours.map((t) => (
            <div key={t.path} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ height: 40, borderRadius: 6, background: v(t), boxShadow: "inset 0 0 0 1px rgb(127 127 127 / .25)" }} />
              <Label>{t.path.slice(t.path.indexOf(".") + 1)}</Label>
            </div>
          ))}
        </div>
      </Block>
    </>
  );
}

const box: CSSProperties = { width: 56, height: 56, background: "rgb(127 127 127 / .14)" };

function SpaceAndShape({ tokens }: { tokens: readonly PreviewToken[] }) {
  const dimensions = of(tokens, "dimension");
  const radii = dimensions.filter((t) => /radius|rounded/.test(t.path));
  const spaces = dimensions.filter((t) => !radii.includes(t));
  return (
    <>
      <Block title="Spacing and sizes">
        {spaces.map((t) => (
          <div key={t.path} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 160 }}>
              <Label>{name(t)}</Label>
            </span>
            <span style={{ height: 12, width: v(t), maxWidth: "60%", background: "currentColor", opacity: 0.5, borderRadius: 2 }} />
          </div>
        ))}
      </Block>
      <Block title="Radii">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          {radii.map((t) => (
            <div key={t.path} style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
              <span style={{ ...box, borderRadius: v(t), boxShadow: "inset 0 0 0 1px currentColor" }} />
              <Label>{name(t)}</Label>
            </div>
          ))}
        </div>
      </Block>
      <Block title="Borders and strokes">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          {of(tokens, "border").map((t) => (
            <div key={t.path} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ width: 120, height: 48, border: v(t), borderRadius: 6 }} />
              <Label>{name(t)}</Label>
            </div>
          ))}
          {of(tokens, "strokeStyle").map((t) => (
            <div key={t.path} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ width: 120, height: 48, borderWidth: 2, borderStyle: v(t) as CSSProperties["borderStyle"], borderColor: "currentColor", borderRadius: 6 }} />
              <Label>{name(t)}</Label>
            </div>
          ))}
        </div>
      </Block>
      <Block title="Shadows">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, padding: 8 }}>
          {of(tokens, "shadow").map((t) => (
            <div key={t.path} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ width: 140, height: 72, borderRadius: 8, background: "inherit", backgroundColor: "rgb(255 255 255 / .02)", boxShadow: v(t) }} />
              <Label>{name(t)}</Label>
            </div>
          ))}
        </div>
      </Block>
    </>
  );
}

const REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A dot that crosses its track with the token's timing; reduced motion runs it only when asked. */
function Track({ token, transition, replay }: { token: PreviewToken; transition: string; replay: number }) {
  const [across, setAcross] = useState(false);
  useEffect(() => {
    if (REDUCED && replay === 0) return;
    setAcross((a) => !a);
    if (REDUCED) return;
    const timer = setInterval(() => setAcross((a) => !a), 1600);
    return () => clearInterval(timer);
  }, [replay]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ width: 180 }}>
        <Label>{name(token)}</Label>
      </span>
      <span style={{ position: "relative", flex: 1, height: 20, borderRadius: 10, background: "rgb(127 127 127 / .14)" }}>
        <span data-motion-dot style={{ position: "absolute", top: 2, left: 2, width: 16, height: 16, borderRadius: 8, background: "currentColor", transform: across ? "translateX(calc(min(60vw, 420px)))" : "none", transition }} />
      </span>
    </div>
  );
}

function Motion({ tokens, replay }: { tokens: readonly PreviewToken[]; replay: number }) {
  const durations = of(tokens, "duration");
  const easings = of(tokens, "cubicBezier");
  const base = durations.at(-1);
  const ease = easings[0];
  const time = base ? v(base) : "300ms";
  return (
    <>
      {REDUCED && <p style={{ margin: "0 0 16px", fontSize: 12, opacity: 0.7 }}>Reduced motion is on: nothing moves until you press Play.</p>}
      <Block title="Springs">
        {of(tokens, "spring").map((t) => (
          <Track key={t.path} token={t} replay={replay} transition={`transform ${v(t, "-duration")} ${v(t)}`} />
        ))}
      </Block>
      <Block title="Durations">
        {durations.map((t) => (
          <Track key={t.path} token={t} replay={replay} transition={`transform ${v(t)} ${ease ? v(ease) : "ease-out"}`} />
        ))}
      </Block>
      <Block title="Easings">
        {easings.map((t) => (
          <Track key={t.path} token={t} replay={replay} transition={`transform ${time} ${v(t)}`} />
        ))}
      </Block>
      <Block title="Transitions">
        {of(tokens, "transition").map((t) => (
          <Track key={t.path} token={t} replay={replay} transition={v(t)} />
        ))}
      </Block>
    </>
  );
}

function Focus({ tokens, demos }: { tokens: readonly PreviewToken[]; demos: Demos }) {
  const surfaces = of(tokens, "color").filter((t) => SURFACE.test(t.path));
  useEffect(() => void ensurePinned("focus"), []);
  return (
    <>
      <Block title="Focus rings">
        {of(tokens, "focusRing").map((ring) => (
          <div key={ring.path} style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {surfaces.map((bg) => (
              <div key={bg.path} style={{ background: v(bg), padding: 16, borderRadius: 8, display: "flex", flexDirection: "column", gap: 8, boxShadow: "inset 0 0 0 1px rgb(127 127 127 / .25)" }}>
                <span style={{ ...box, width: 96, height: 32, borderRadius: 6, outline: v(ring), outlineOffset: v(ring, "-offset") }} />
                <Label>
                  {name(ring)} on {bg.path.split(".").at(-1)}
                </Label>
              </div>
            ))}
          </div>
        ))}
      </Block>
      <Block title="Focused components">
        <div data-pin-state="focus">
          <AllComponents demos={demos} />
        </div>
      </Block>
    </>
  );
}

export function Screen({ screen, tokens, demos, replay }: { screen: PreviewScreen; tokens: readonly PreviewToken[]; demos: Demos; replay: number }) {
  switch (screen) {
    case "components":
      return <AllComponents demos={demos} />;
    case "type":
      return <TypeAndColour tokens={tokens} />;
    case "scale":
      return <SpaceAndShape tokens={tokens} />;
    case "motion":
      return <Motion tokens={tokens} replay={replay} />;
    case "focus":
      return <Focus tokens={tokens} demos={demos} />;
  }
}
