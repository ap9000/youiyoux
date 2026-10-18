/**
 * youiyoux-report.html: one self-contained file to open or send. Inline CSS, images as data:
 * URIs, no scripts, and a Content-Security-Policy of `default-src 'none'`, so it makes no
 * request of any kind. Light and dark follow the reader's system; the layout is fluid from a
 * phone's 360 px up. One section per project, and every finding ends with what to do next.
 * The model it is given has already been cleaned (safe.ts); everything is HTML-escaped here.
 *
 * It follows youiyoux's own design system (apps/web/design: design.md and rules/): a dashboard
 * frame with a section rail, a headline sentence with a split bar, a shape map, findings as rows
 * in panels, near-duplicates compared side
 * by side, colour only for status and action, and mono for machine facts.
 */
import type { Finding, ProjectSection, RenderedLook, ReportModel } from "./model.ts";
import { NPX } from "./model.ts";

const escape = (text: string | number): string => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const plural = (count: number, word: string, many = `${word}s`): string => `${count} ${count === 1 ? word : many}`;
const anchor = (dir: string): string => `p-${dir === "." ? "root" : dir.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

// The hub's tokens (apps/web/design/youiyoux*.tokens.json), light then dark.
const CSS = `
:root{color-scheme:light dark;--canvas:#f4f5f7;--surface:#fcfcfd;--raised:#f6f7f9;--sunken:#f8f9fa;--line:#e3e4e8;--line-strong:#d0d2d8;--ink:#16171a;--ink-2:#3d4049;--muted:#6b6f78;--faint:#9ea2ab;--accent:#5e6ad2;--accent-soft:#eceefa;--success:#4f7a69;--success-soft:#eaf1ee;--danger:#ad5a43;--danger-soft:#f7ece8;--neutral-soft:#eef0f3;--k-dup:var(--accent);--k-hard:color-mix(in oklch,var(--accent) 55%,var(--surface));--k-off:color-mix(in oklch,var(--accent) 25%,var(--surface));--shadow:0 1px 2px rgba(16,17,20,.04)}
@media (prefers-color-scheme:dark){:root{--canvas:#08090a;--surface:#0f1011;--raised:#151618;--sunken:#0b0c0d;--line:#1d1e21;--line-strong:#2b2c30;--ink:#f7f8f8;--ink-2:#d0d6e0;--muted:#8a8f98;--faint:#62666d;--accent:#7170ff;--accent-soft:#1a1b33;--success:#8fb5a4;--success-soft:#14201b;--danger:#d99a85;--danger-soft:#251713;--neutral-soft:#191a1d;--shadow:none}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.5 Geist,"Geist Variable",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code,pre,.mono{font-family:"Geist Mono","Geist Mono Variable",ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
code{background:var(--neutral-soft);border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--ink-2)}
pre{background:var(--sunken);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
h1,h2,h3,h4,p{margin:0}
.shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.rail{position:sticky;top:0;height:100vh;overflow-y:auto;border-right:1px solid var(--line);background:var(--surface);padding:16px 12px;display:flex;flex-direction:column;gap:16px}
.brand{display:flex;align-items:center;gap:10px;padding:2px 6px;font-weight:600;font-size:14px}
.mark{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;background:var(--ink);color:var(--canvas);font-size:13px;font-weight:700}
.rail nav{display:flex;flex-direction:column;gap:1px}
.rail .group{font-size:11.5px;color:var(--faint);padding:12px 8px 4px}
.rail a{display:flex;justify-content:space-between;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:6px;color:var(--ink-2);font-size:13px}
.rail a:hover{background:var(--raised);color:var(--ink);text-decoration:none}
.rail a .n{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.rail a .n.warn{color:var(--ink)}
.rail .foot{margin-top:auto;font-size:11.5px;color:var(--faint);padding:0 8px}
main{min-width:0;padding:28px 32px 64px;max-width:1120px;width:100%;margin:0 auto}
.top{display:flex;flex-direction:column;gap:10px;padding-bottom:20px}
.crumb{font-size:12px;color:var(--muted)}
.top h1{font-size:24px;line-height:1.2;font-weight:650;letter-spacing:-.01em}
.facts{display:flex;flex-wrap:wrap;gap:6px;padding:0;margin:0;list-style:none}
.facts li{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:12px;color:var(--ink-2)}
.facts li b{font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.headline{display:flex;flex-direction:column;gap:14px;padding:4px 0 8px}
.say{font-size:26px;line-height:1.3;font-weight:600;letter-spacing:-.015em;max-width:30em}
.say b{font-variant-numeric:tabular-nums;font-weight:700}
.say b.warn{color:var(--ink);box-shadow:inset 0 -.14em 0 var(--line-strong)}
.say b.ok{color:var(--success)}
.split{display:flex;height:10px;border-radius:5px;overflow:hidden;gap:2px;background:var(--neutral-soft)}
.seg{display:block;height:100%;min-width:3px}
.s0{background:var(--k-dup)}
.s1{background:var(--k-hard)}
.s2{background:var(--k-off)}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;margin:0;padding:0;list-style:none;font-size:12.5px;color:var(--ink-2)}
.legend a{color:inherit;display:inline-flex;align-items:center;gap:7px}
.legend b{color:var(--ink);font-variant-numeric:tabular-nums}
.legend .key{width:10px;height:10px;border-radius:3px;display:inline-block}
.legend .key.zero{background:var(--line-strong)}
.legend .clean{color:var(--success);font-size:11.5px}
.legend .of{margin-left:auto;color:var(--muted);font-size:12px}
.shapes{list-style:none;margin:0;padding:0}
.shapes li{display:grid;grid-template-columns:120px minmax(0,1fr) 150px;align-items:center;gap:14px;padding:9px 0;border-top:1px solid var(--line)}
.shapes li:first-child{border-top:0}
.shapes .role{font-size:12.5px;color:var(--ink)}
.shapes .sq{display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0}
.shapes i,.panel header i.k{display:inline-block;width:14px;height:14px;border-radius:3px}
.shapes i.one,i.k.one{background:var(--faint)}
.shapes i.more,i.k.more{background:var(--accent-soft);box-shadow:inset 0 0 0 1.5px var(--accent)}
.panel header i.k{width:10px;height:10px;vertical-align:-1px;margin:0 4px 0 10px}
.shapes .over{font-size:11.5px;color:var(--muted);margin-left:4px}
.shapes .unmeasured{font-size:12px;color:var(--faint);font-style:italic}
.shapes .val{text-align:right;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.shapes .drift .val b{color:var(--ink)}
.shapes .even .val b{color:var(--success)}
section{scroll-margin-top:16px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;margin:16px 0 0;box-shadow:var(--shadow);overflow:hidden}
.panel>header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--raised)}
.panel>header h2,.panel>header h3{font-size:14px;font-weight:600}
.panel>header .aside{font-size:12px;color:var(--muted);text-align:right}
.panel>.body{padding:14px 16px}
.panel>.body>*+*{margin-top:10px}
.panel>.body+.findings{border-top:1px solid var(--line)}
.muted,small{color:var(--muted)}
small{font-size:12px}
.next{font-size:13px;color:var(--ink-2)}
.next strong{color:var(--accent);font-weight:600}
.none{color:var(--success);font-weight:500;font-size:13px}
.incomplete{color:var(--muted);font-size:12.5px;margin-top:12px}
.incomplete summary{color:var(--muted)}
.unread{margin:8px 0 0;padding-left:18px;font-size:12px}
.legend .alert{position:relative;margin-left:auto}
.legend .alert+.of{margin-left:0}
.legend .alert a{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:11.5px}
.legend .alert a:hover,.legend .alert a:focus-visible{color:var(--ink);border-color:var(--line-strong);text-decoration:none}
.legend .alert i{display:inline-grid;place-items:center;width:13px;height:13px;border-radius:50%;background:var(--danger-soft);color:var(--danger);font-style:normal;font-size:9.5px;font-weight:700}
.legend .tip{position:absolute;z-index:5;top:calc(100% + 6px);right:0;width:260px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink-2);font-size:12px;line-height:1.45;box-shadow:0 8px 24px rgba(0,0,0,.12);opacity:0;visibility:hidden;transition:opacity .12s}
.legend .alert:hover .tip,.legend .alert:focus-within .tip{opacity:1;visibility:visible}
.unread-at{scroll-margin-top:16px}
ol.findings,ul.findings{list-style:none;padding:0;margin:0}
.finding{padding:14px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.finding:first-child{border-top:0}
.head{display:flex;align-items:flex-start;gap:12px}
.count{flex:none;width:44px;padding:4px 0 3px;border-radius:6px;background:var(--neutral-soft);color:var(--ink);font-weight:650;font-size:13px;line-height:1.1;display:flex;flex-direction:column;align-items:center;font-variant-numeric:tabular-nums}
.count small{font-size:9.5px;font-weight:500;color:inherit;opacity:.8;letter-spacing:.02em}
.head .what{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.finding .title{font-weight:600;font-size:13.5px;line-height:1.4}
.finding .what .muted{font-size:12.5px}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--kind,var(--faint));order:-1}
.chip:has(.swatch)::before{display:none}
[data-kind=near-duplicate]{--kind:var(--k-dup)}
[data-kind=hardcoded-value]{--kind:var(--k-hard)}
[data-kind=off-library]{--kind:var(--k-off)}
.chip{flex:none;display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;background:var(--neutral-soft);color:var(--ink-2);font-size:11.5px;font-weight:500;white-space:nowrap}
.swatch{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--line-strong);flex:none}
.specs{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 0 56px;margin:0;list-style:none}
.specs li{height:22px;padding:0 8px;border-radius:6px;border:1px solid var(--line);background:var(--sunken);display:inline-flex;align-items:center;font-family:"Geist Mono","Geist Mono Variable",ui-monospace,"SF Mono",Menlo,monospace;font-size:11.5px;color:var(--ink-2)}
.compare{margin-left:56px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.compare>.next,.compare>.steps,.compare>.more,.compare>.shot{margin:0;padding:10px 12px}
.compare>.next{grid-column:1;grid-row:1 / span 2;border-right:1px solid var(--line);background:var(--sunken)}
.compare>.next::before{content:"Canonical";display:block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2);margin-bottom:4px}
.compare>.next strong{display:none}
.compare>.steps{grid-column:2;list-style:none;font-size:12.5px;color:var(--ink-2);display:flex;flex-direction:column;gap:6px}
.compare>.steps::before{content:"Replace";display:block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.compare>.steps li,.compare>.more .steps li{padding-left:14px;position:relative}
.compare>.steps li::before,.compare>.more .steps li::before{content:"";position:absolute;left:2px;top:.6em;width:5px;height:5px;border-radius:50%;background:var(--faint)}
.compare>.more{grid-column:2;padding-top:0}
.compare>.more .steps{list-style:none;padding:6px 0 0;margin:0;font-size:12.5px;color:var(--ink-2);display:flex;flex-direction:column;gap:6px}
.compare>.shot{grid-column:1 / -1;border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;background:var(--sunken)}
.shot figure{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}
.shot figcaption{font-size:11.5px;color:var(--muted)}
.shot img{display:block;width:100%;max-width:360px;height:140px;object-fit:cover;object-position:top left;border-radius:6px;border:1px solid var(--line);background:var(--surface)}
.steps{margin:0;padding-left:20px;color:var(--ink-2);font-size:12.5px}
.more summary{cursor:pointer;color:var(--accent);font-size:12.5px;list-style:none}
.more summary::-webkit-details-marker{display:none}
.more summary::before{content:"+ "}
.more[open] summary::before{content:"− "}
.sites{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 0 56px;padding:0;list-style:none}
.sites li{font-size:12px;color:var(--muted);display:inline-flex;align-items:center}
.sites.code{display:block}
.sites.code li{display:block;margin:6px 0}
.finding>.next{margin-left:56px}
.rows{list-style:none;padding:0;margin:0}
.rows li{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding:8px 0;font-size:13px}
.rows li:first-child{border-top:0}
.rows li span:last-child{color:var(--muted);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.rows small{font-family:"Geist Mono","Geist Mono Variable",ui-monospace,"SF Mono",Menlo,monospace;font-size:11.5px;margin-left:6px}
h4{font-size:12px;font-weight:600;color:var(--muted);margin-top:16px}
.agent{display:flex;flex-direction:column;gap:4px;background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;padding:12px 16px;margin:16px 0 0;font-size:13px}
.agent strong{font-weight:600}
.looks{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:12px}
.looks figure{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--sunken);min-width:0}
.looks figcaption{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--surface);font-size:13px;font-weight:600}
.looks figcaption small{min-width:0;font-weight:400;font-family:"Geist Mono","Geist Mono Variable",ui-monospace,"SF Mono",Menlo,monospace;font-size:11px;text-align:right}
.looks .pair{display:grid;grid-template-columns:1fr 1fr}
.looks img{display:block;width:100%;height:220px;object-fit:cover;object-position:top left}
.looks figure>p{padding:8px 12px;border-top:1px solid var(--line);font-size:12px}
.project{margin-top:40px}
.project>h2{font-size:18px;font-weight:650;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.project>h2 small{font-family:"Geist Mono","Geist Mono Variable",ui-monospace,"SF Mono",Menlo,monospace;font-weight:400}
.projects nav ul{list-style:none;padding:0;margin:0}
.projects nav li{border-top:1px solid var(--line);padding:6px 0;font-size:13px}
.projects nav li:first-child{border-top:0}
footer{margin-top:48px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:16px;display:flex;flex-direction:column;gap:6px}
@media (max-width:860px){
.shell{display:block}
.rail{position:sticky;top:0;z-index:2;height:auto;flex-direction:row;align-items:center;gap:8px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line);overflow-x:auto;overflow-y:hidden}
.rail .group,.rail .foot,.brand span:last-child{display:none}
.rail nav{flex-direction:row;gap:4px}
.rail a{white-space:nowrap;height:28px;border:1px solid var(--line)}
main{padding:20px 16px 48px}
html{scroll-padding-top:60px}
section{scroll-margin-top:60px}
.panel>header .aside{display:none}
.specs,.sites,.compare,.finding>.next{margin-left:0;padding-left:0}
.compare{grid-template-columns:minmax(0,1fr)}
.compare>.next{grid-row:auto;border-right:0;border-bottom:1px solid var(--line)}
.compare>.steps,.compare>.more{grid-column:1}
.compare>.shot{grid-template-columns:minmax(0,1fr)}
.say{font-size:20px}
.legend .of{margin-left:0}
.shapes li{grid-template-columns:minmax(0,1fr) auto;gap:8px}
.shapes .sq{grid-column:1 / -1;grid-row:2}
}
`;

/** Escaped text with its machine facts (imports, file paths, CSS variables, token names) set in mono. */
const FACT = /import \{[^}]*\} from &quot;[^&]*&quot;|var\(--[\w-]+\)|(?<![\w/.-])(?:[\w@.\[\]-]+\/)+[\w.\[\]-]+\.(?:tsx|ts|jsx|js|mjs|css|scss|vue|svelte|astro|html)(?::\d+)?|\b(?:color|radius|spacing|space|size|font|shadow|typography)\.[\w-]+/g;
const rich = (text: string): string => escape(text).replace(FACT, (fact) => `<span class="mono">${fact}</span>`);

function next(text: string): string {
  return `<p class="next"><strong>Next:</strong> ${rich(text.replace(/\.$/, ""))}.</p>`;
}

/** Steps a near-duplicate fix lists before the rest fold away under "and N more". */
const STEPS_SHOWN = 5;

const KIND: Record<Finding["kind"], string> = { "near-duplicate": "Duplicate", "hardcoded-value": "Hardcoded", "off-library": "Off-library" };

/** A finding title's measurements, "(32px high, 12px side padding, …)", split off as chips. */
function splitMeasures(title: string): { text: string; measures: string[] } {
  const m = /\s*\(([^()]*\d[^()]*)\)/.exec(title);
  if (!m) return { text: title, measures: [] };
  return { text: (title.slice(0, m.index) + title.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(), measures: m[1]!.split(/,\s*/).filter(Boolean) };
}

/** A CSS colour named in a title, only in shapes that cannot carry anything else into a style attribute. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\([0-9.,%\s/+-]+\)/;
function swatch(title: string): string {
  const colour = COLOUR.exec(title)?.[0];
  return colour ? `<span class="swatch" style="background:${escape(colour)}" aria-hidden="true"></span>` : "";
}

/** Rendered looks by defining file, to show a near-duplicate's builds in its comparison. */
type Looks = ReadonlyMap<string, RenderedLook>;

function shots(f: Finding, looks: Looks): string {
  if (looks.size === 0) return "";
  const kept = /\(([^()]+\.[a-z]+)\)/.exec(f.lead ?? "")?.[1];
  const copy = (f.steps ?? []).map((s) => /^In ([^,]+),/.exec(s)?.[1]).find((file) => file !== undefined && file !== kept && looks.has(file));
  const pair: Array<readonly [string, RenderedLook]> = [];
  if (kept && looks.get(kept)?.light) pair.push(["Keep", looks.get(kept)!]);
  if (copy && looks.get(copy)?.light) pair.push(["Copy", looks.get(copy)!]);
  if (pair.length === 0) return "";
  return `<div class="shot">${pair.map(([label, look]) => `<figure><picture>${look.dark ? `<source media="(prefers-color-scheme: dark)" srcset="${look.dark}">` : ""}<img alt="${escape(look.component)} (${label.toLowerCase()})" src="${look.light}"></picture><figcaption>${label} · ${escape(look.component)} <span class="mono">${escape(look.file)}</span></figcaption></figure>`).join("")}</div>`;
}

function finding(f: Finding, showProject: boolean, looks: Looks): string {
  const { text, measures } = f.kind === "near-duplicate" ? splitMeasures(f.title) : { text: f.title, measures: [] };
  const where = showProject && f.project !== "." ? `<p class="muted">in <span class="mono">${escape(f.project)}</span></p>` : "";
  const head = `<div class="head"><span class="count">${f.count}<small>${f.count === 1 ? "place" : "places"}</small></span><div class="what"><p class="title">${rich(text)}</p>${f.detail ? `<p class="muted">${escape(f.detail)}</p>` : ""}${where}</div><span class="chip">${f.kind === "hardcoded-value" ? swatch(f.title) : ""}${KIND[f.kind]}</span></div>`;
  const specs = measures.length > 0 ? `<ul class="specs">${measures.map((m) => `<li>${escape(m)}</li>`).join("")}</ul>` : "";
  if (f.lead && f.steps && f.steps.length > 0) {
    // What to keep beside the files to change: the first few, the rest folded (no script needed).
    const item = (step: string): string => `<li>${rich(step.replace(/\.$/, ""))}</li>`;
    const rest = f.steps.slice(STEPS_SHOWN);
    const more = rest.length > 0 ? `<details class="more"><summary>and ${plural(rest.length, "more file")}</summary><ol class="steps" start="${STEPS_SHOWN + 1}">${rest.map(item).join("")}</ol></details>` : "";
    return `<li class="finding" data-kind="${f.kind}">${head}${specs}<div class="compare">${next(f.lead)}<ol class="steps">${f.steps.slice(0, STEPS_SHOWN).map(item).join("")}</ol>${more}${shots(f, looks)}</div></li>`;
  }
  const code = f.sites.some((s) => s.code);
  const sites = f.sites.map((s) => `<li><code>${escape(s.at)}</code>${s.code ? `<pre>${escape(s.code)}</pre>` : ""}</li>`).join("");
  const more = f.count > f.sites.length ? `<li>+ ${plural(f.count - f.sites.length, "more place")}</li>` : "";
  return `<li class="finding" data-kind="${f.kind}">${head}${specs}<ul class="sites${code ? " code" : ""}">${sites}${more}</ul>${next(f.next)}</li>`;
}

function findings(list: readonly Finding[], none: string, after: string, looks: Looks): string {
  if (list.length === 0) return `<div class="body"><p class="none">${escape(none)}</p>${next(after)}</div>`;
  return `<ul class="findings">${list.map((f) => finding(f, false, looks)).join("")}</ul>`;
}

function panel(name: string, id: string, title: string, aside: string, body: string, level: "h2" | "h3" = "h3"): string {
  return `<section class="panel" data-section="${name}" id="${id}"><header><${level}>${escape(title)}</${level}>${aside ? `<span class="aside">${aside}</span>` : ""}</header>${body}</section>`;
}

function projectSection(p: ProjectSection, many: boolean, looks: Looks): string {
  const id = anchor(p.dir);
  const where = p.dir === "." ? "" : ` --project ${p.dir}`;
  const libraries = p.libraries.length === 0
    ? `<div class="body"><p class="none">No UI library found.</p>${next(`if it uses one, run ${NPX} detect ${p.dir} to see what was read`)}</div>`
    : `<div class="body"><ul class="rows">${p.libraries.map((l) => `<li><span>${escape(l.name)}${l.for.length > 0 ? ` <small>${escape(l.for.join(", "))}</small>` : ""}</span><span>${escape(l.confidence)} confidence</span></li>`).join("")}</ul>${p.unused.length > 0 ? `<p class="muted">Declared but never imported (not counted): ${escape(p.unused.join(", "))}</p>` : ""}${next(`build new UI with these, not a new library: ${NPX} agents install tells your agent so`)}</div>`;
  const kits = p.kits.length > 0 ? `<p class="muted">Kits: ${p.kits.map((k) => `<code>${escape(k.path)}</code> (${escape(k.kind)}, ${plural(k.members, "member")})`).join(", ")}</p>` : "";
  const components = p.components.length > 0 ? `<h4>Most used</h4><ul class="rows">${p.components.map((c) => `<li><span>${escape(c.name)}<small>${escape(c.file)}</small></span><span>${plural(c.uses, "use")}</span></li>`).join("")}</ul>` : "";
  const inventory = `<div class="body"><p>${plural(p.definitions, "component")} defined in ${plural(p.files, "file")}; ${plural(p.uses, "UI element")} in use (buttons, links styled as buttons, inputs, cards, badges, dialogs, tabs).</p>${p.roles.length > 0 ? `<ul class="rows">${p.roles.map((r) => `<li><span class="mono">${escape(r.role)}</span><span>${plural(r.uses, "use")} · ${plural(r.families, "shape")}</span></li>`).join("")}</ul>` : ""}${kits}${components}${next(`see every look grouped by shape with ${NPX} inventory${where}`)}</div>`;
  const unread = p.failed.length > 0 ? `<details class="incomplete more"><summary>${plural(p.failed.length, "file")} not fully read; what is in them is unknown</summary><ul class="unread">${p.failed.map((f) => `<li>${rich(f)}</li>`).join("")}</ul></details>` : "";
  const count = (list: readonly Finding[]): string => (list.length === 0 ? "None" : `${plural(list.length, "finding")} · ${plural(list.reduce((n, f) => n + f.count, 0), "place")}`);
  return `<section class="project" data-section="project" data-project="${escape(p.dir)}" id="${id}">
<h2>${escape(many || p.dir !== "." ? p.dir : "This repo")}${p.name && p.name !== p.dir ? ` <small>${escape(p.name)}</small>` : ""}</h2>
${p.incomplete.length > 0 || p.failed.length > 0 ? `<div class="unread-at" id="${id}-unread">${p.incomplete.map((i) => `<p class="incomplete">${escape(i)}</p>`).join("")}${unread}</div>` : ""}
${panel("near-duplicates", `${id}-near`, "Near-duplicate groups", count(p.nearDuplicates), `<div class="body"><p class="muted">Components that look the same (height, padding, corners, text size and weight) but are built more than once.</p></div>${findings(p.nearDuplicates, "None found: each look is built once.", `keep it that way: ${NPX} agents install has your agent reuse these components`, looks)}`)}
${panel("hardcoded", `${id}-hardcoded`, "Hardcoded values that should be tokens", count(p.hardcoded), `<div class="body"><p class="muted">Colours, spacing and radii written as literals although a theme variable holds the same value.</p></div>${findings(p.hardcoded, "None found.", `run ${NPX} check --diff on each change to keep new literals out`, looks)}`)}
${panel("off-library", `${id}-off`, "Off-library imports", count(p.offLibrary), `<div class="body"><p class="muted">Imports of an element from a library other than the one the rest of the code uses for it.</p></div>${findings(p.offLibrary, "None found.", `run ${NPX} check --diff on each change to catch a second library early`, looks)}`)}
${panel("inventory", `${id}-inventory`, "Component inventory", `${plural(p.definitions, "component")} · ${plural(p.uses, "use")}`, inventory)}
${panel("libraries", `${id}-libraries`, "UI libraries", p.libraries.length > 0 ? plural(p.libraries.length, "library", "libraries") : "", libraries)}
${p.notes.map((n) => `<p class="muted">${escape(n.replace(/\.?$/, "."))}</p>`).join("")}
</section>`;
}

function looksSection(model: ReportModel): string {
  const drawn = model.projects.flatMap((p) => p.rendered.map((r) => ({ ...r, project: p.dir })));
  const body = drawn.length > 0
    ? `<div class="looks">${drawn.map((r) => `<figure data-component="${escape(r.component)}"><figcaption>${escape(r.component)} <small>${escape(r.file)}</small></figcaption><div class="pair">${r.light ? `<img alt="${escape(r.component)}, light" src="${r.light}">` : ""}${r.dark ? `<img alt="${escape(r.component)}, dark" src="${r.dark}">` : ""}</div>${r.looks.length > 0 ? `<p class="muted">${plural(r.looks.length, "look")} drawn, light and dark</p>` : ""}</figure>`).join("")}</div>`
    : "";
  const after = model.render.next ? next(model.render.next) : drawn.length > 0 ? next(`see a component after you change it with ${NPX} render <file>`) : next(model.render.state === "off" ? `run ${NPX} --render to draw the most-used components (it asks before downloading the ~100 MB headless Chromium, once)` : `run ${NPX} render <file> to see why a component could not be drawn`);
  return `<section class="panel" data-section="looks" data-render="${model.render.state}" id="looks"><header><h2>Rendered looks</h2><span class="aside">${drawn.length > 0 ? plural(drawn.length, "component") : ""}</span></header><div class="body">${body}<p class="${drawn.length > 0 ? "muted" : ""}">${escape(model.render.note)}</p>${after}</div></section>`;
}

/** The headline (layout: a sentence with its numbers in it, then one bar that splits the places to fix). */
/** Places to fix by kind, in the headline's order: what the split bar and the share card both draw. */
export function placesByKind(model: ReportModel): ReadonlyArray<{ readonly label: string; readonly places: number }> {
  const places = (pick: (p: ProjectSection) => readonly Finding[]): number => model.projects.reduce((n, p) => n + pick(p).reduce((m, f) => m + f.count, 0), 0);
  return [
    { label: "Near-duplicates", places: places((p) => p.nearDuplicates) },
    { label: "Hardcoded values", places: places((p) => p.hardcoded) },
    { label: "Off-library imports", places: places((p) => p.offLibrary) },
  ];
}

function headline(model: ReportModel): string {
  const t = model.totals;
  const [near, hard, off] = placesByKind(model);
  const parts = [
    { label: "Near-duplicates", places: near!.places, href: model.projects.length > 1 ? "top-fixes" : `${anchor(model.projects[0]?.dir ?? ".")}-near` },
    { label: "Hardcoded values", places: hard!.places, href: model.projects.length > 1 ? "top-fixes" : `${anchor(model.projects[0]?.dir ?? ".")}-hardcoded` },
    { label: "Off-library imports", places: off!.places, href: model.projects.length > 1 ? "top-fixes" : `${anchor(model.projects[0]?.dir ?? ".")}-off` },
  ];
  const total = parts.reduce((n, part) => n + part.places, 0);
  const n = (value: number): string => `<b class="${value > 0 ? "warn" : "ok"}">${value}</b>`;
  const unknown = model.projects.some((p) => p.incomplete.length > 0 || p.failed.length > 0);
  const analyses = model.projects.reduce((n, p) => n + p.incomplete.length, 0);
  const unread = model.projects.reduce((n, p) => n + p.failed.length, 0);
  const caveat = [analyses > 0 ? `${plural(analyses, "analysis", "analyses")} could not run` : "", unread > 0 ? `${plural(unread, "file")} could not be fully read` : ""].filter(Boolean).join(" and ");
  const said: string[] = [];
  if (t.nearDuplicates > 0) said.push(`${n(t.nearDuplicates)} ${t.nearDuplicates === 1 ? "look is" : "looks are"} built more than once`);
  if (t.hardcoded > 0) said.push(`${n(t.hardcoded)} ${t.hardcoded === 1 ? "value skips" : "values skip"} the theme`);
  if (t.offLibrary > 0) said.push(`${n(t.offLibrary)} ${t.offLibrary === 1 ? "import comes" : "imports come"} from a second library`);
  const sentence = said.length === 0
    ? `Every look is built once and every value comes from the theme${unknown ? ", in what could be read" : ""}.`
    : `${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0]}: <b class="warn">${total}</b> ${total === 1 ? "place" : "places"} to fix.`;
  const bar = total > 0 ? `<div class="split" role="img" aria-label="${parts.map((part) => `${part.label} ${part.places}`).join(", ")}">${parts.map((part, i) => (part.places > 0 ? `<span class="seg s${i}" style="width:${((part.places / total) * 100).toFixed(2)}%"></span>` : "")).join("")}</div>` : "";
  const legend = `<ul class="legend">${parts.map((part, i) => `<li><a href="#${part.href}"><span class="key s${i}${part.places === 0 ? " zero" : ""}"></span>${escape(part.label)} <b>${part.places}</b>${part.places === 0 ? ` <span class="clean">Clean</span>` : ""}</a></li>`).join("")}${unknown ? `<li class="alert"><a href="#${anchor(model.projects.find((p) => p.failed.length > 0 || p.incomplete.length > 0)?.dir ?? ".")}-unread" aria-describedby="unread-tip"><i aria-hidden="true">!</i>${analyses + unread} not read</a><span class="tip" id="unread-tip" role="tooltip">${escape(caveat.charAt(0).toUpperCase() + caveat.slice(1))}: what is in them is unknown, not zero.</span></li>` : ""}<li class="of">${plural(t.definitions, "component")} · ${plural(t.uses, "UI element")} in use · ${plural(t.files, "file")}</li></ul>`;
  return `<section class="headline" data-section="headline"><p class="say">${sentence}</p>${bar}${legend}</section>`;
}

/** Shapes per element (one square per distinct look; one is consistent, every extra square is drift). */
const SQUARES = 40;
function shapeMap(model: ReportModel): string {
  const roles = new Map<string, { uses: number; families: number }>();
  for (const p of model.projects) for (const r of p.roles) {
    const was = roles.get(r.role) ?? { uses: 0, families: 0 };
    roles.set(r.role, { uses: was.uses + r.uses, families: was.families + r.families });
  }
  if (roles.size === 0) return "";
  const rows = [...roles].map(([role, { uses, families }]) => {
    const shown = Math.min(families, SQUARES);
    const squares = families === 0
      ? `<span class="unmeasured">shape not measured</span>`
      : `${Array.from({ length: shown }, (_, i) => `<i class="${i === 0 ? "one" : "more"}"></i>`).join("")}${families > shown ? `<span class="over">+${families - shown}</span>` : ""}`;
    return `<li class="${families > 1 ? "drift" : families === 1 ? "even" : ""}"><span class="role mono">${escape(role)}</span><span class="sq">${squares}</span><span class="val"><b>${families}</b> ${families === 1 ? "shape" : "shapes"} · ${plural(uses, "use")}</span></li>`;
  }).join("");
  const many = model.projects.length > 1 ? ", summed over the projects" : "";
  return `<section class="panel" data-section="shapes" id="shapes"><header><h2>Shapes per element</h2><span class="aside"><i class="k one"></i>first shape <i class="k more"></i>each extra shape</span></header><div class="body"><p class="muted">One square per distinct look of each kind of element${many}. One square is consistent; every extra square is a copy someone built.</p><ul class="shapes">${rows}</ul></div></section>`;
}

function rail(model: ReportModel, many: boolean): string {
  const t = model.totals;
  const link = (href: string, label: string, n?: number, warn = false): string => `<a href="#${href}"><span>${escape(label)}</span>${n === undefined ? "" : `<span class="n${warn && n > 0 ? " warn" : ""}">${n}</span>`}</a>`;
  const report = [link("overview", "Overview"), link("shapes", "Shapes"), link("top-fixes", "Top fixes", model.topFixes.length, true), link("looks", "Rendered looks")];
  const projects = many
    ? model.projects.map((p) => link(anchor(p.dir), p.dir, p.nearDuplicates.length + p.hardcoded.length + p.offLibrary.length, true))
    : model.projects.flatMap((p) => {
        const id = anchor(p.dir);
        return [link(`${id}-near`, "Near-duplicates", t.nearDuplicates, true), link(`${id}-hardcoded`, "Hardcoded values", t.hardcoded, true), link(`${id}-off`, "Off-library imports", t.offLibrary, true), link(`${id}-inventory`, "Inventory", t.definitions), link(`${id}-libraries`, "UI libraries", t.libraries.length)];
      });
  return `<aside class="rail"><div class="brand"><span class="mark">Y</span><span>youiyoux</span></div><nav aria-label="Sections"><div class="group">Report</div>${report.join("")}<div class="group">${many ? "Projects" : "Findings"}</div>${projects.join("")}</nav><p class="foot">Self-contained. Nothing was uploaded.</p></aside>`;
}

export function renderHtml(model: ReportModel): string {
  const t = model.totals;
  const many = model.projects.length > 1;
  const date = model.generatedAt.slice(0, 10);
  const looks: Looks = new Map(model.projects.flatMap((p) => p.rendered.map((r) => [r.file, r] as const)));
  const top = model.topFixes.length > 0 ? `<ol class="findings">${model.topFixes.map((f) => finding(f, many, looks)).join("")}</ol>` : `<div class="body"><p class="none">Nothing to fix first.</p>${next(`${NPX} agents install, so your agent keeps it that way`)}</div>`;
  const libraries = t.libraries.length > 0 ? `<li>${escape(t.libraries.join(" · "))}</li>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>youiyoux report: ${escape(model.repo)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="shell">
${rail(model, many)}
<main>
<header class="top" id="overview">
<p class="crumb">youiyoux report</p>
<h1>${escape(model.repo)}</h1>
<ul class="facts"><li><b>${t.files}</b> files</li><li><b>${t.projects}</b> ${t.projects === 1 ? "project" : "projects"}</li>${libraries}<li class="mono">${escape(date)}</li><li class="mono">${(model.durationMs / 1000).toFixed(1)} s</li></ul>
</header>
${headline(model)}
${shapeMap(model)}
${panel("top-fixes", "top-fixes", "Top fixes", "Ranked by how many places each one touches", top, "h2")}
<aside class="agent" data-section="agent"><p><strong>${escape(model.agent)}</strong></p>${next(`${NPX} agents install, then restart your agent`)}</aside>
${looksSection(model)}
<section class="panel projects" data-section="projects" id="projects"><header><h2>Projects</h2><span class="aside">${plural(model.projects.length, "project")}</span></header><div class="body"><p>${escape(model.layout.charAt(0).toUpperCase() + model.layout.slice(1))}.</p>${many ? `<nav><ul>${model.projects.map((p) => `<li><a href="#${anchor(p.dir)}">${escape(p.dir)}</a>${p.name && p.name !== p.dir ? ` <small>${escape(p.name)}</small>` : ""}</li>`).join("")}</ul></nav>` : ""}${next(many ? "open each project below; each has its own fixes" : "read this repo's section below")}</div></section>
${model.projects.map((p) => projectSection(p, many, looks)).join("\n")}
<footer>
<p>Made with ${escape(NPX)} on ${escape(date)} in ${(model.durationMs / 1000).toFixed(1)} s. This file is self-contained: it loads nothing from the network, and nothing was uploaded.</p>
<p>Paths are relative to the repo. ${model.includeCode ? "Lines of code were included (--include-code); keys, tokens and environment values in them were removed." : "Includes relative paths, component names, class lists, counts and rendered images when available. Literal prop values and text content are omitted from captions and fixes; --include-code adds source lines and full captions."} Home paths, usernames, environment values and credentials were removed.</p>
</footer>
</main>
</div>
</body>
</html>
`;
}
