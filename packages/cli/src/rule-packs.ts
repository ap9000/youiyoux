/**
 * Rule packs: starter rules youiyoux offers and never installs by itself. `youiyoux rules add`
 * lists them; `youiyoux rules add <pack>` writes that pack's rule files, and only those, into the
 * System's rules folder, as warnings. A rule whose id (or file) is already there is left as it is.
 * Nothing else (adopt, scan, sync, check) ever adds one.
 *
 * The behaviour pack is one rule per behaviour check (docs/plans/behaviour-rules.md): a probe run
 * in the running app checks them (`youiyoux behave`), so until one has run `youiyoux check` says
 * they are incomplete, never clean.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { RuleSpec, writeFileAtomic, type BehaviourCheckId, type LoadedSystem } from "@youiyoux/core";

/** What every behaviour rule's agent text ends with: how an agent sees that its fix works. */
const VERIFY = "Verify with ui_behave (or `youiyoux behave --route <route>`).";

interface Starter {
  readonly name: string;
  readonly title: string;
  readonly statement: string;
  readonly rationale: string;
  readonly agent: string;
  readonly check: BehaviourCheckId;
  readonly bad: readonly string[];
  readonly good: readonly string[];
}

const BEHAVIOUR: readonly Starter[] = [
  {
    name: "behaviour.trigger-state",
    check: "trigger-state",
    title: "A popup's button says when it is open",
    statement:
      'The button that opens a menu, listbox or popover says what it opens and whether it is open: aria-expanded is "false" while closed and "true" while open, aria-haspopup fits the popup ("menu" for a menu; a combobox implies its listbox), and aria-controls, when present, names the popup itself (a combobox needs it). A popovertarget button gets this from the browser.',
    rationale: "A screen reader announces the button, not the popup. Without aria-expanded a person can't tell that pressing it opened anything, or that something is still open.",
    agent: `On a button that opens a menu, listbox or popover, set aria-haspopup ("menu" for a menu), aria-expanded={open} and aria-controls={the popup's id}, or use popovertarget for a native popover. ${VERIFY}`,
    bad: ['<button aria-haspopup="menu" onClick={() => setOpen(!open)}>More</button> // never says it is open'],
    good: ['<button aria-haspopup="menu" aria-expanded={open} aria-controls="more-menu" onClick={() => setOpen(!open)}>More</button>', '<button popovertarget="filters">Filters</button>'],
  },
  {
    name: "behaviour.dismiss-escape",
    check: "dismiss-escape",
    title: "Esc closes the popup",
    statement: "Pressing Esc closes an open menu, listbox, modal dialog or popover: with focus inside the popup (or on the combobox), one Esc closes it within a second and a half.",
    rationale: "Esc is how keyboard and screen reader users get out. A popup that ignores it traps them, or leaves something covering the page.",
    agent: `Close the popup on Escape: handle keydown "Escape" on the popup (or on the combobox) and close it; a native <dialog> opened with showModal() and a [popover] close on Esc by themselves. ${VERIFY}`,
    bad: ['<div role="menu">…</div> // no Escape handling: it stays open'],
    good: ['<div role="menu" onKeyDown={(e) => { if (e.key === "Escape") close(); }}>…</div>'],
  },
  {
    name: "behaviour.focus-into",
    check: "focus-into",
    title: "Opening a menu or dialog moves focus into it",
    statement:
      "When a menu opens, focus moves to one of its items (an aria-activedescendant naming an item counts); when a modal dialog opens, focus moves inside it (onto something focusable, or the dialog itself with tabindex=-1). Focus left on the button, or on the menu container alone, fails. A combobox keeps focus by design and isn't checked.",
    rationale: "Keyboard users act where focus is. Focus left behind on the button means their next key acts on the page under the popup.",
    agent: `When a menu opens, focus its first item (items take tabIndex={-1}; call .focus() on it); when a modal dialog opens, focus its first field or the dialog itself (tabIndex={-1}); showModal() does this for a native <dialog>. ${VERIFY}`,
    bad: ['{open && <div role="menu"><button role="menuitem">Rename</button></div>} // focus stays on the button'],
    good: ['useEffect(() => { if (open) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }, [open]);'],
  },
  {
    name: "behaviour.focus-return",
    check: "focus-return",
    title: "Closing with Esc puts focus back on its button",
    statement: "When Esc closes a menu, modal dialog or popover, focus goes back to the button that opened it, or to the part the component's contract names as returnFocusTo. Focus dropped on the page, or anywhere else, fails.",
    rationale: "Without it a keyboard user is sent back to the top of the page and has to find their place again.",
    agent: `When the popup closes on Esc, call .focus() on the button that opened it (keep a ref to it); if that button is removed on close, declare a11y.behaviour.returnFocusTo in the component's contract. ${VERIFY}`,
    bad: ['onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} // focus falls to <body>'],
    good: ['onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); buttonRef.current?.focus(); } }}'],
  },
  {
    name: "behaviour.focus-trap",
    check: "focus-trap",
    title: "Tab stays inside an open modal dialog",
    statement:
      "While a modal dialog is open, Tab and Shift+Tab move through its focusable elements in order and wrap from the last to the first (and back); focus never leaves the dialog, and Tab is never swallowed. A dialog with nothing focusable in it keeps focus on itself.",
    rationale: "A modal dialog says the rest of the page is unavailable. If Tab walks out of it, keyboard users act on a page they can't see; if Tab does nothing, they can't reach the dialog's buttons.",
    agent: `Open a modal dialog as a native <dialog> with showModal(), or with role="dialog", aria-modal="true" and a focus trap that moves Tab through its elements and wraps; never block every Tab. Give the button that opens it aria-haspopup="dialog", so the probe can find it. ${VERIFY}`,
    bad: ['<div role="dialog" aria-modal="true">…</div> // Tab walks out to the page behind'],
    good: ["<dialog ref={dialogRef}>…</dialog> // opened with dialogRef.current.showModal()"],
  },
  {
    name: "behaviour.arrow-keys",
    check: "arrow-keys",
    title: "Arrow keys move through a menu or listbox",
    statement:
      "In an open vertical menu or listbox, ArrowDown moves to the next item and ArrowUp to the previous one, in order (on a combobox, aria-activedescendant names the active option). At the ends, wrapping and stopping are both fine; disabled items may take focus or be skipped. Horizontal menus aren't checked yet.",
    rationale: "Arrow keys are how keyboard and screen reader users move through a list of choices. A menu that answers only to the mouse or to Tab can't be used without a pointer.",
    agent: `In a menu, move focus between items on ArrowDown and ArrowUp (items tabIndex={-1}; .focus() the next one); in a combobox, keep focus on the input and point aria-activedescendant at the active option's id. ${VERIFY}`,
    bad: ['<div role="menu">{items.map((item) => <button role="menuitem" key={item}>{item}</button>)}</div> // arrows do nothing'],
    good: ['onKeyDown={(e) => { if (e.key === "ArrowDown") focusItem(index + 1); if (e.key === "ArrowUp") focusItem(index - 1); }}'],
  },
];

export interface RulePack {
  readonly name: string;
  /** One line on what the pack checks and how. */
  readonly summary: string;
  /** The pack's rules for a System, with that System's ids. */
  readonly rules: (system: string) => ReadonlyArray<{ readonly file: string; readonly spec: RuleSpec }>;
}

export const RULE_PACKS: readonly RulePack[] = [
  {
    name: "behaviour",
    summary: "how popups (menus, comboboxes, modal dialogs, popovers) behave with a keyboard, one rule per check; youiyoux behave checks them in the running dev app",
    rules: (system) =>
      BEHAVIOUR.map((s) => ({
        file: `${s.name}.rule.yaml`,
        spec: RuleSpec.parse({
          schema: "youi.rule/v1",
          id: `youi:${system}/rule/${s.name}`,
          title: s.title,
          severity: "warn",
          statement: s.statement,
          rationale: s.rationale,
          agent: s.agent,
          check: { engine: "behaviour", id: s.check, options: {} },
          files: ["**/*.{tsx,jsx}"],
          examples: { bad: [...s.bad], good: [...s.good] },
        }),
      })),
  },
];

export const rulePack = (name: string): RulePack | undefined => RULE_PACKS.find((p) => p.name === name);

/** A rule file as `rules add` writes it: the rule's fields in their usual order, as YAML. */
export const ruleYaml = (spec: RuleSpec): string => stringify(spec, { lineWidth: 0 });

export interface RulePackTarget {
  /** The design repo's root: the rules folder must stay inside it, through links too. */
  readonly root: string;
  readonly system: LoadedSystem;
}

export interface AddedRules {
  readonly pack: string;
  /** The rules folder, absolute. */
  readonly dir: string;
  /** File names written (or, with dryRun, that would be). */
  readonly added: readonly string[];
  /** Rules left as they were: id already a rule of the System, or a file of that name already there. */
  readonly kept: ReadonlyArray<{ readonly file: string; readonly why: string }>;
}

/**
 * Write a pack's rule files into the System's rules folder, each atomically, never over a file or
 * an id that is already there. Writes those files and nothing else.
 */
export async function addRulePack(target: RulePackTarget, pack: RulePack, options: { readonly dryRun?: boolean } = {}): Promise<AddedRules> {
  const dir = join(target.root, target.system.config.rules);
  const base = await realpath(target.root);
  // The folder, or (not made yet) its nearest existing parent, through every link.
  let real: string | null = null;
  for (let at = dir; real === null; at = dirname(at)) real = await realpath(at).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" && dirname(at) !== at ? null : Promise.reject(error)));
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`the rules folder ${target.system.config.rules} leads outside the design repo (to ${relative(base, real)}): rules add writes only inside it`);
  const ids = new Set(target.system.rules.map((r) => r.id));
  const added: string[] = [];
  const kept: Array<{ file: string; why: string }> = [];
  const writes: Array<{ path: string; content: string }> = [];
  for (const { file, spec } of pack.rules(target.system.config.id)) {
    const path = join(dir, file);
    if (ids.has(spec.id)) kept.push({ file, why: `${spec.id} is already a rule of ${target.system.config.id}` });
    else if (await lstat(path).then(() => true, () => false)) kept.push({ file, why: `${file} is already in the rules folder` });
    else {
      writes.push({ path, content: ruleYaml(spec) });
      added.push(file);
    }
  }
  if (!options.dryRun) for (const w of writes) await writeFileAtomic(w.path, w.content);
  return { pack: pack.name, dir, added, kept };
}
