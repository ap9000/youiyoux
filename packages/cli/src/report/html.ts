/**
 * youiyoux-report.html: one self-contained file to open or send. Inline CSS, images as data:
 * URIs, no scripts, and a Content-Security-Policy of `default-src 'none'`, so it makes no
 * request of any kind. Light and dark follow the reader's system; the layout is fluid from a
 * phone's 360 px up. One section per project, and every finding ends with what to do next.
 * The model it is given has already been cleaned (safe.ts); everything is HTML-escaped here.
 */
import type { Finding, ProjectSection, ReportModel } from "./model.ts";
import { NPX } from "./model.ts";

const escape = (text: string | number): string => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const plural = (count: number, word: string, many = `${word}s`): string => `${count} ${count === 1 ? word : many}`;
const anchor = (dir: string): string => `p-${dir === "." ? "root" : dir.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

const CSS = `
:root{color-scheme:light dark;--bg:#f7f8fb;--surface:#fff;--line:#e3e6ef;--text:#141826;--muted:#5b6478;--accent:#3651d6;--warn:#a15c00;--warn-bg:#fff4e0;--ok:#16794a;--code:#eef1f8}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--surface:#121a30;--line:#25304f;--text:#e8ecf8;--muted:#a3adc6;--accent:#8ea6ff;--warn:#fbbf24;--warn-bg:#2b2410;--ok:#4ade80;--code:#1a2340}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}
main{max-width:960px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:clamp(28px,6vw,44px);line-height:1.1;margin:4px 0 8px}
h2{font-size:22px;margin:40px 0 12px}
h3{font-size:17px;margin:28px 0 8px}
p{margin:6px 0}
code,pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--code);border-radius:4px;padding:1px 5px}
pre{background:var(--code);border-radius:6px;padding:8px 10px;margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.eyebrow{color:var(--accent);font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:13px;margin:0}
.meta,.muted,small{color:var(--muted)}
.summary{padding-left:20px}
.summary li{margin:4px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0 0;padding:0}
.stats div{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stats dt{color:var(--muted);font-size:14px}
.stats dd{margin:0;font-size:32px;font-weight:700;line-height:1.2}
.stats .warn dd{color:var(--warn)}
.stats .ok dd{color:var(--ok)}
.card,.finding,.agent{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:10px 0}
.agent{border-color:var(--accent)}
ol.findings,ul.findings{list-style:none;padding:0;margin:0}
.finding .title{font-weight:600;margin:0}
.sites{margin:6px 0;padding-left:18px;color:var(--muted)}
.sites li{margin:2px 0}
.next{margin-top:8px}
.steps{margin:4px 0 0;padding-left:22px;color:var(--muted);font-size:15px}
.steps li{margin:3px 0}
.more summary{cursor:pointer;color:var(--accent);margin:4px 0 0 4px;font-size:15px}
.next strong{color:var(--accent)}
.none{color:var(--ok);font-weight:600}
.incomplete{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:8px 12px}
.project{border-top:2px solid var(--line);margin-top:48px}
.project>h2{margin-top:24px}
.pills{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none;margin:6px 0}
.pills li{background:var(--code);border-radius:999px;padding:3px 12px;font-size:14px}
.rows{list-style:none;padding:0;margin:6px 0}
.rows li{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:6px 0}
.rows li span:last-child{color:var(--muted);text-align:right;white-space:nowrap}
.looks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px}
.looks figure{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px}
.looks .pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.looks img{display:block;width:100%;height:auto;border-radius:6px;border:1px solid var(--line)}
.looks figcaption{font-weight:600;margin-bottom:8px}
nav ul{padding-left:20px}
footer{margin-top:56px;color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:16px}
`;

function next(text: string): string {
  return `<p class="next"><strong>Next:</strong> ${escape(text.replace(/\.$/, ""))}.</p>`;
}

/** Steps a near-duplicate fix lists before the rest fold away under "and N more". */
const STEPS_SHOWN = 5;

function finding(f: Finding, showProject: boolean): string {
  const head = `<p class="title">${escape(f.title)}</p>${f.detail ? `<p class="muted">${escape(f.detail)}</p>` : ""}${showProject && f.project !== "." ? `<p class="muted">in ${escape(f.project)}</p>` : ""}`;
  if (f.lead && f.steps && f.steps.length > 0) {
    // What to keep, then one short line per file: the first few, the rest folded (no script needed).
    const item = (step: string): string => `<li>${escape(step.replace(/\.$/, ""))}</li>`;
    const rest = f.steps.slice(STEPS_SHOWN);
    const more = rest.length > 0 ? `<details class="more"><summary>and ${plural(rest.length, "more file")}</summary><ol class="steps" start="${STEPS_SHOWN + 1}">${rest.map(item).join("")}</ol></details>` : "";
    return `<li class="finding" data-kind="${f.kind}">${head}${next(f.lead)}<ol class="steps">${f.steps.slice(0, STEPS_SHOWN).map(item).join("")}</ol>${more}</li>`;
  }
  const sites = f.sites.map((s) => `<li><code>${escape(s.at)}</code>${s.code ? `<pre>${escape(s.code)}</pre>` : ""}</li>`).join("");
  const more = f.count > f.sites.length ? `<li>… and ${plural(f.count - f.sites.length, "more place")}</li>` : "";
  return `<li class="finding" data-kind="${f.kind}">${head}<ul class="sites">${sites}${more}</ul>${next(f.next)}</li>`;
}

function findings(list: readonly Finding[], none: string, after: string): string {
  if (list.length === 0) return `<p class="none">${escape(none)}</p>${next(after)}`;
  return `<ul class="findings">${list.map((f) => finding(f, false)).join("")}</ul>`;
}

function projectSection(p: ProjectSection, many: boolean): string {
  const where = p.dir === "." ? "" : ` --project ${p.dir}`;
  const libraries = p.libraries.length === 0
    ? `<p class="none">No UI library found.</p>${next(`if it uses one, run ${NPX} detect ${p.dir} to see what was read`)}`
    : `<ul class="rows">${p.libraries.map((l) => `<li><span>${escape(l.name)}${l.for.length > 0 ? ` <small>· ${escape(l.for.join(", "))}</small>` : ""}</span><span>${escape(l.confidence)} confidence</span></li>`).join("")}</ul>${p.unused.length > 0 ? `<p class="muted">Declared but never imported (not counted): ${escape(p.unused.join(", "))}</p>` : ""}${next(`build new UI with these, not a new library: ${NPX} agents install tells your agent so`)}`;
  const roles = p.roles.map((r) => `<li><span>${escape(r.role)}</span><span>${plural(r.uses, "use")} · ${plural(r.families, "shape")}</span></li>`).join("");
  const kits = p.kits.length > 0 ? `<p>Kits: ${p.kits.map((k) => `<code>${escape(k.path)}</code> (${escape(k.kind)}, ${plural(k.members, "member")})`).join(", ")}</p>` : "";
  const components = p.components.length > 0 ? `<h4>Most used</h4><ul class="rows">${p.components.map((c) => `<li><span>${escape(c.name)} <small>${escape(c.file)}</small></span><span>${plural(c.uses, "use")}</span></li>`).join("")}</ul>` : "";
  const inventory = `<p>${plural(p.definitions, "component")} defined in ${plural(p.files, "file")}; ${plural(p.uses, "UI element")} in use (buttons, links styled as buttons, inputs, cards, badges, dialogs, tabs).</p>${kits}${roles ? `<ul class="rows">${roles}</ul>` : ""}${components}${next(`see every look grouped by shape with ${NPX} inventory${where}`)}`;
  const incomplete = [...p.incomplete, ...p.failed.map((f) => `Not fully read: ${f}`)];
  return `<section class="project" data-section="project" data-project="${escape(p.dir)}" id="${anchor(p.dir)}">
<h2>${escape(many || p.dir !== "." ? p.dir : "This repo")}${p.name && p.name !== p.dir ? ` <small>${escape(p.name)}</small>` : ""}</h2>
${incomplete.map((i) => `<p class="incomplete">${escape(i)}</p>`).join("")}
<section data-section="libraries"><h3>UI libraries</h3>${libraries}</section>
<section data-section="inventory"><h3>Component inventory</h3>${inventory}</section>
<section data-section="near-duplicates"><h3>Near-duplicate groups</h3><p class="muted">Components that look the same (height, padding, corners, text size and weight) but are built more than once.</p>${findings(p.nearDuplicates, "None found: each look is built once.", `keep it that way: ${NPX} agents install has your agent reuse these components`)}</section>
<section data-section="hardcoded"><h3>Hardcoded values that should be tokens</h3><p class="muted">Colours, spacing and radii written as literals although a theme variable holds the same value.</p>${findings(p.hardcoded, "None found.", `run ${NPX} check --diff on each change to keep new literals out`)}</section>
<section data-section="off-library"><h3>Off-library imports</h3><p class="muted">Imports of an element from a library other than the one the rest of the code uses for it.</p>${findings(p.offLibrary, "None found.", `run ${NPX} check --diff on each change to catch a second library early`)}</section>
${p.notes.map((n) => `<p class="muted">${escape(n.replace(/\.?$/, "."))}</p>`).join("")}
</section>`;
}

function looks(model: ReportModel): string {
  const drawn = model.projects.flatMap((p) => p.rendered.map((r) => ({ ...r, project: p.dir })));
  const body = drawn.length > 0
    ? `<div class="looks">${drawn.map((r) => `<figure data-component="${escape(r.component)}"><figcaption>${escape(r.component)} <small>${escape(r.file)}</small></figcaption><div class="pair">${r.light ? `<img alt="${escape(r.component)}, light" src="${r.light}">` : ""}${r.dark ? `<img alt="${escape(r.component)}, dark" src="${r.dark}">` : ""}</div>${r.looks.length > 0 ? `<p class="muted">${escape(r.looks.slice(0, 4).join(" · "))}</p>` : ""}</figure>`).join("")}</div>`
    : "";
  return `<section data-section="looks" data-render="${model.render.state}"><h2>Rendered looks</h2>${body}<p class="${drawn.length > 0 ? "muted" : ""}">${escape(model.render.note)}</p>${model.render.next ? next(model.render.next) : drawn.length > 0 ? next(`see a component after you change it with ${NPX} render <file>`) : next(model.render.state === "off" ? `run ${NPX} --render to draw the most-used components (it asks before downloading the ~100 MB headless Chromium, once)` : `run ${NPX} render <file> to see why a component could not be drawn`)}</section>`;
}

export function renderHtml(model: ReportModel): string {
  const t = model.totals;
  const many = model.projects.length > 1;
  const stat = (label: string, value: number, tone = ""): string => `<div class="${tone}"><dt>${escape(label)}</dt><dd>${value}</dd></div>`;
  const tone = (n: number): string => (n > 0 ? "warn" : "ok");
  const date = model.generatedAt.slice(0, 10);
  const top = model.topFixes.length > 0 ? `<ol class="findings">${model.topFixes.map((f) => finding(f, many)).join("")}</ol>` : `<p class="none">Nothing to fix first.</p>${next(`${NPX} agents install, so your agent keeps it that way`)}`;
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
<main>
<header>
<p class="eyebrow">youiyoux report</p>
<h1>${escape(model.repo)}</h1>
<p class="meta">${plural(t.projects, "project")} · ${plural(t.files, "file")} · scanned ${escape(date)}</p>
<ul class="summary">${model.summary.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
<dl class="stats">${stat("Components defined", t.definitions)}${stat("Near-duplicate groups", t.nearDuplicates, tone(t.nearDuplicates))}${stat("Hardcoded values", t.hardcoded, tone(t.hardcoded))}${stat("Off-library imports", t.offLibrary, tone(t.offLibrary))}</dl>
</header>
<section data-section="top-fixes"><h2>Top fixes</h2><p class="muted">Ranked by how many places each one touches.</p>${top}</section>
<aside class="agent" data-section="agent"><p><strong>${escape(model.agent)}</strong></p>${next(`${NPX} agents install, then restart your agent`)}</aside>
${looks(model)}
<section data-section="projects"><h2>Projects</h2><p>${escape(model.layout.charAt(0).toUpperCase() + model.layout.slice(1))}.</p>${many ? `<nav><ul>${model.projects.map((p) => `<li><a href="#${anchor(p.dir)}">${escape(p.dir)}</a>${p.name && p.name !== p.dir ? ` <small>${escape(p.name)}</small>` : ""}</li>`).join("")}</ul></nav>` : ""}${next(many ? "open each project below; each has its own fixes" : "read this repo's section below")}</section>
${model.projects.map((p) => projectSection(p, many)).join("\n")}
<footer>
<p>Made with ${escape(NPX)} on ${escape(date)} in ${(model.durationMs / 1000).toFixed(1)} s. This file is self-contained: it loads nothing from the network, and nothing was uploaded.</p>
<p>Paths are relative to the repo. ${model.includeCode ? "Lines of code were included (--include-code); keys, tokens and environment values in them were removed." : "Includes relative paths, component names, class lists, counts and rendered images when available. Literal prop values and text content are omitted from captions and fixes; --include-code adds source lines and full captions."} Home paths, usernames, environment values and credentials were removed.</p>
</footer>
</main>
</body>
</html>
`;
}
