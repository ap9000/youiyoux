/**
 * A menu button (WAI-ARIA menu pattern): Enter, Space or ↓ opens it on the first item,
 * ↑ on the last; arrows, Home and End move; Escape or Tab closes it and focus returns
 * to the button. For a few secondary verbs beside a page's one primary action.
 */
import type { LucideIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button.tsx";

export interface MenuItem {
  readonly label: string;
  /** A second line, e.g. the exact text an item copies. */
  readonly detail?: string;
  readonly icon?: LucideIcon;
  readonly onSelect: () => void;
}

interface MenuButtonProps {
  /** The accessible name of the button. */
  label: string;
  children: ReactNode;
  items: readonly MenuItem[];
  className?: string;
}

export function MenuButton({ label, children, items, className }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<"first" | "last">("first");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const entries = (): HTMLButtonElement[] => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const list = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    (start === "first" ? list[0] : list.at(-1))?.focus();
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open, start]);

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setStart(event.key === "ArrowDown" ? "first" : "last");
    setOpen(true);
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const list = entries();
    const index = list.findIndex((entry) => entry === document.activeElement);
    const move = (to: number): void => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(false);
  };

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setStart("first");
          setOpen((value) => !value);
        }}
        onKeyDown={onButtonKey}
        className={className}
      >
        {children}
      </Button>
      {open && (
        <div ref={menuRef} id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKey} className="absolute top-full right-0 z-20 mt-1 w-72 rounded-lg border border-line bg-surface p-1 shadow-popover origin-top-right animate-menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                item.onSelect();
                close(true);
              }}
              className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
            >
              {item.icon && <item.icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />}
              <span className="min-w-0">
                <span className="block text-body text-ink">{item.label}</span>
                {item.detail && <span className="block truncate font-mono text-mono-sm text-muted">{item.detail}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
