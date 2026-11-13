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
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { RuleSpec, withFileLock, type BehaviourCheckId, type LoadedSystem } from "@youiyoux/core";

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
      'The button that opens a popup says whether it is open. A menu button has aria-haspopup="menu" (or "true"), and aria-expanded="true" while the menu is open ("false" or left off while it is closed); aria-controls, if set, names the menu. A combobox has aria-expanded="false" while its listbox is closed and "true" while it is open, and aria-controls naming the listbox; aria-haspopup is left off or "listbox". Any other popover\'s button either uses popovertarget (the browser says whether it is open; a hand-set aria-expanded must agree) or has aria-controls naming the popover and aria-expanded="true" while it is open ("false" or left off while it is closed). A modal dialog\'s button isn\'t checked.',
    rationale: "A screen reader announces the button, not the popup. Without aria-expanded a person can't tell that pressing it opened anything, or that something is still open.",
    agent: `Menu button: aria-haspopup="menu" and aria-expanded={open}. Combobox: aria-expanded={open}, always set, and aria-controls={the listbox's id}; aria-haspopup off or "listbox". Other popovers: popovertarget, or aria-controls={the popover's id} with aria-expanded={open}; they need no aria-haspopup. ${VERIFY}`,
    bad: ['<button aria-haspopup="menu" onClick={() => setOpen(!open)}>More</button> // never says it is open'],
    good: ['<button aria-haspopup="menu" aria-expanded={open} aria-controls="more-menu" onClick={() => setOpen(!open)}>More</button>', '<input role="combobox" aria-expanded={open} aria-controls="city-options" />', '<button popovertarget="filters">Filters</button>'],
  },
  {
    name: "behaviour.dismiss-escape",
    check: "dismiss-escape",
    title: "Esc closes the popup",
    statement: "Pressing Esc closes an open menu, listbox, modal dialog or popover: with focus inside the popup (or on the combobox), one Esc closes it within a second and a half.",
    rationale: "Esc is how keyboard and screen reader users get out. A popup that ignores it traps them, or leaves something covering the page.",
    agent: `Close the popup on Escape: handle keydown "Escape" on the popup (or on the combobox) and close it. A native <dialog> opened with showModal() and an auto popover (popover or popover="auto") close on Esc by themselves; a popover="manual" doesn't, so close it yourself. ${VERIFY}`,
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

/** The lock `rules add` writers take turns under, in the rules folder (not a rule file: the loader reads only *.rule.yaml). */
export const RULES_LOCK = ".youi-rules.lock";
/** How long a second `rules add` waits for the first before giving up, naming the holder. */
const LOCK_WAIT_MS = 10_000;

/** The ids of the rule files in the folder now, read from disk (a file that can't be read as a rule names no id). */
async function idsOnDisk(dir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
  for (const name of names.filter((n) => n.endsWith(".rule.yaml"))) {
    try {
      const id = (parseYaml(await readFile(join(dir, name), "utf8")) as { id?: unknown } | null)?.id;
      if (typeof id === "string") ids.add(id);
    } catch {
      // Not readable as YAML: it names no id, and its file name is still never written over.
    }
  }
  return ids;
}

/**
 * The file published at `path` only if nothing is there: written whole to an exclusive temp file
 * beside it, then hard-linked into place (link fails if the name exists, whoever made it, even a
 * dangling link), then the temp removed. False when the name was taken.
 */
async function publishNew(path: string, content: string): Promise<boolean> {
  const temp = join(dirname(path), `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    await link(temp, path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export interface AddRulePackOptions {
  readonly dryRun?: boolean;
  /** Tests only: called after the ids and names are read under the lock, before each file is published. */
  readonly beforePublish?: (file: string) => Promise<void>;
}

/**
 * Write a pack's rule files into the System's rules folder, never over a file or an id that is
 * already there. Writers take turns under the folder's lock; inside it the ids are read again from
 * disk, and each file is published only if its name is still free (link, never rename), so a rule
 * someone else made meanwhile is kept, not replaced. Writes those files (and the lock, removed after)
 * and nothing else.
 */
export async function addRulePack(target: RulePackTarget, pack: RulePack, options: AddRulePackOptions = {}): Promise<AddedRules> {
  const dir = join(target.root, target.system.config.rules);
  const base = await realpath(target.root);
  // The folder, or (not made yet) its nearest existing parent, through every link.
  const inside = async (): Promise<void> => {
    let real: string | null = null;
    for (let at = dir; real === null; at = dirname(at)) real = await realpath(at).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" && dirname(at) !== at ? null : Promise.reject(error)));
    if (real !== base && !real.startsWith(base + sep)) throw new Error(`the rules folder ${target.system.config.rules} leads outside the design repo (to ${relative(base, real)}): rules add writes only inside it`);
  };
  await inside();
  const rules = pack.rules(target.system.config.id);
  const sort = async (ids: Set<string>) => {
    const free: Array<{ file: string; spec: RuleSpec }> = [];
    const kept: Array<{ file: string; why: string }> = [];
    for (const rule of rules) {
      if (ids.has(rule.spec.id)) kept.push({ file: rule.file, why: `${rule.spec.id} is already a rule of ${target.system.config.id}` });
      else if (await lstat(join(dir, rule.file)).then(() => true, () => false)) kept.push({ file: rule.file, why: `${rule.file} is already in the rules folder` });
      else free.push(rule);
    }
    return { free, kept };
  };
  if (options.dryRun) {
    const { free, kept } = await sort(new Set([...target.system.rules.map((r) => r.id), ...(await idsOnDisk(dir))]));
    return { pack: pack.name, dir, added: free.map((r) => r.file), kept };
  }
  await mkdir(dir, { recursive: true });
  await inside();
  return withFileLock(join(dir, RULES_LOCK), async () => {
    const { free, kept } = await sort(await idsOnDisk(dir));
    const added: string[] = [];
    for (const { file, spec } of free) {
      await options.beforePublish?.(file);
      if (await publishNew(join(dir, file), ruleYaml(spec))) added.push(file);
      else kept.push({ file, why: `${file} was made by someone else meanwhile` });
    }
    return { pack: pack.name, dir, added, kept };
  }, { waitMs: LOCK_WAIT_MS });
}
