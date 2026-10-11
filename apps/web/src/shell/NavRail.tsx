/**
 * The nav rail: the mark, one icon per screen, and search / theme / shortcuts at the foot.
 * Screens are grouped by the half of the tool they belong to, each group labelled, so the
 * System (what products build with) never reads as the same place as the Library.
 */
import { clsx } from "clsx";
import { Keyboard, Moon, Search, Sun, SunMoon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { isActive, NAV_SECTIONS, navGroups, type NavGroup, type NavItem } from "../app/routes.tsx";
import { cycleTheme, useTheme } from "../app/theme.tsx";
import { Keys } from "../ui/Kbd.tsx";
import { setOverlay } from "./keyboard.ts";

const ITEM = "group relative grid size-9 place-items-center rounded-md transition-colors duration-100 [&>svg]:size-4";
const IDLE = "text-muted hover:bg-line/60 hover:text-ink";
const ACTIVE = "bg-surface text-ink shadow-raise edge";

/** A tooltip that opens to the right of a rail item, after a short hover or on keyboard focus. */
function Tip({ label, keys }: { label: string; keys?: readonly string[] }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-full z-40 ml-2.5 flex items-center gap-2 rounded-md border border-line bg-surface py-1 pr-1.5 pl-2 text-small font-medium whitespace-nowrap text-ink opacity-0 shadow-popover transition-opacity duration-100 group-hover:opacity-100 group-hover:delay-300 group-focus-visible:opacity-100"
    >
      {label}
      {keys && <Keys keys={keys} />}
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={clsx("size-7", className)}>
      <rect width="24" height="24" rx="7" className="fill-accent" />
      <path d="M7.5 7.5 12 12l4.5-4.5M12 12v4.5" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="stroke-on-accent" />
    </svg>
  );
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link href={item.href} aria-label={item.label} aria-current={active ? "page" : undefined} className={clsx(ITEM, active ? ACTIVE : IDLE)}>
      <Icon />
      <Tip label={item.label} keys={["g", item.key]} />
    </Link>
  );
}

function RailButton({ label, keys, onClick, children }: { label: string; keys?: readonly string[]; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className={clsx(ITEM, IDLE)}>
      {children}
      <Tip label={label} keys={keys} />
    </button>
  );
}

function RailGroup({ group, location }: { group: NavGroup; location: string }) {
  const links = group.items.map((item) => <RailLink key={item.href} item={item} active={isActive(item, location)} />);
  if (!group.section) return <>{links}</>;
  const { label, hint } = NAV_SECTIONS[group.section];
  const id = `rail-${group.section}`;
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col items-center gap-1">
      <span id={id} title={hint} className="pt-1 text-caption font-medium text-muted select-none">
        {label}
      </span>
      {links}
    </div>
  );
}

const THEME_ICON = { system: SunMoon, light: Sun, dark: Moon } as const;
const THEME_LABEL = { system: "Theme: follows the system", light: "Theme: light", dark: "Theme: dark" } as const;

export function NavRail() {
  const [location] = useLocation();
  const { choice } = useTheme();
  const ThemeIcon = THEME_ICON[choice];
  return (
    <nav aria-label="Main" className="flex w-[var(--yx-size-rail)] shrink-0 flex-col items-center gap-1 py-2">
      <Link href="/" aria-label="YouIyouX home" className="mb-3 grid size-9 place-items-center rounded-md">
        <Logo />
      </Link>
      {navGroups().map((group, i) => (
        <Fragment key={group.section ?? `plain-${i}`}>
          {i > 0 && <span aria-hidden className="my-1 h-px w-6 shrink-0 bg-line" />}
          <RailGroup group={group} location={location} />
        </Fragment>
      ))}
      <div className="mt-auto flex flex-col items-center gap-1">
        <RailButton label="Search" keys={["⌘", "K"]} onClick={() => setOverlay("palette")}>
          <Search />
        </RailButton>
        <RailButton label={THEME_LABEL[choice]} onClick={cycleTheme}>
          <ThemeIcon />
        </RailButton>
        <RailButton label="Keyboard shortcuts" keys={["?"]} onClick={() => setOverlay("help")}>
          <Keyboard />
        </RailButton>
      </div>
    </nav>
  );
}
