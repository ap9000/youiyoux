/** ⌘K: jump to any element, screen or setting. Elements come from the same worker search as the lists. */
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { ArrowRight, Moon, Search, Sun, SunMoon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { NAV } from "../app/routes.tsx";
import { setTheme, type ThemeChoice, useTheme } from "../app/theme.tsx";
import { elementHref } from "../data/ids.ts";
import type { ElementSummary } from "../data/model.ts";
import { useModelState } from "../data/store.ts";
import { markNavigation } from "../lib/perf.ts";
import { useSearch } from "../search/client.ts";
import { Keys, Kbd } from "../ui/Kbd.tsx";
import { KindIcon } from "../ui/KindIcon.tsx";

const MAX_ELEMENTS = 12;
const KIND_LABEL = { component: "Component", token: "Token", rule: "Rule", migration: "Migration" } as const;
const THEMES: ReadonlyArray<{ choice: ThemeChoice; label: string; icon: typeof Sun }> = [
  { choice: "system", label: "Theme: follow the system", icon: SunMoon },
  { choice: "light", label: "Theme: light", icon: Sun },
  { choice: "dark", label: "Theme: dark", icon: Moon },
];

const ITEM =
  "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-body text-ink-2 select-none data-[selected=true]:bg-raised data-[selected=true]:text-ink [&_svg]:shrink-0";
const LIST =
  "max-h-[min(60vh,440px)] scroll-py-1.5 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-muted";

const matches = (label: string, query: string): boolean => label.toLowerCase().includes(query.trim().toLowerCase());

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [, navigate] = useLocation();
  const { scheme } = useTheme();
  const state = useModelState();
  const model = state.status === "ready" ? state.value : null;
  const search = useSearch(model, query);

  const elements = useMemo((): ElementSummary[] => {
    if (!model) return [];
    if (search.ids === null) return model.elements.filter((e) => e.kind === "component");
    return search.ids.slice(0, MAX_ELEMENTS).flatMap((id) => model.byId.get(id) ?? []);
  }, [model, search.ids]);
  const screens = NAV.filter((item) => matches(item.label, query) || matches(`go ${item.label}`, query));
  const themes = THEMES.filter((t) => matches(t.label, query));

  // Highlight the best match whenever the results change, not whatever was highlighted before.
  const first = elements[0]?.id ?? (screens[0] ? `go ${screens[0].href}` : themes[0] ? `theme ${themes[0].choice}` : "");
  const [selected, setSelected] = useState(first);
  useEffect(() => setSelected(first), [first]);

  const go = (href: string): void => {
    if (href !== location.pathname) markNavigation(href);
    navigate(href);
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade" />
        <Dialog.Content aria-describedby={undefined} className="fixed inset-x-0 top-[12vh] z-50 mx-auto w-[min(640px,calc(100vw-24px))] overflow-hidden rounded-xl border border-line bg-surface shadow-popover outline-none animate-pop">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command shouldFilter={false} loop label="Command palette" value={selected} onValueChange={setSelected}>
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search aria-hidden className="size-4 text-muted" />
              <Command.Input value={query} onValueChange={setQuery} placeholder="Search elements, tokens and rules, or jump to a screen…" className="h-12 min-w-0 flex-1 bg-transparent text-reading text-ink outline-none placeholder:text-muted" />
              <Kbd>esc</Kbd>
            </div>
            <Command.List className={LIST}>
              <Command.Empty className="px-3 py-8 text-center text-small text-muted">Nothing matches “{query.trim()}”.</Command.Empty>
              {elements.length > 0 && (
                <Command.Group heading={search.ids === null ? "Components" : "Elements"}>
                  {elements.map((element) => (
                    <Command.Item key={element.id} value={element.id} onSelect={() => go(elementHref(element.id))} className={ITEM}>
                      <KindIcon element={element} scheme={scheme} />
                      <span className="truncate font-medium text-ink">{element.name}</span>
                      {element.key !== element.name && <span className="truncate font-mono text-mono-sm text-muted">{element.key}</span>}
                      <span className="ml-auto text-caption text-muted">{KIND_LABEL[element.kind]}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {screens.length > 0 && (
                <Command.Group heading="Go to">
                  {screens.map((item) => (
                    <Command.Item key={item.href} value={`go ${item.href}`} onSelect={() => go(item.href)} className={ITEM}>
                      <item.icon className="size-4 text-muted" />
                      <span>{item.label}</span>
                      <Keys keys={["g", item.key]} className="ml-auto" />
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {themes.length > 0 && (
                <Command.Group heading="Appearance">
                  {themes.map((theme) => (
                    <Command.Item key={theme.choice} value={`theme ${theme.choice}`} onSelect={() => (setTheme(theme.choice), onClose())} className={ITEM}>
                      <theme.icon className="size-4 text-muted" />
                      <span>{theme.label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
            <footer className="flex h-9 items-center gap-4 border-t border-line bg-sunken px-4 text-caption text-muted">
              <span className="flex items-center gap-1.5">
                <Keys keys={["↑", "↓"]} /> move
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd> open
              </span>
              {search.totalMs !== null && (
                <span className="ml-auto flex items-center gap-1 tabular">
                  <ArrowRight className="size-3" /> {search.ids?.length ?? 0} in {search.totalMs.toFixed(1)} ms
                </span>
              )}
            </footer>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
