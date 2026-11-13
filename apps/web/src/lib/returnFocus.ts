/**
 * Focus goes back to whatever opened a dialog when it closes. The hub's dialogs are controlled
 * (open from a plain button, with no Dialog.Trigger), so Radix has no trigger to give focus back to
 * and, after Esc, the close button or the scrim, focus fell to the page's body. Pass the handler to
 * Dialog.Content's onCloseAutoFocus: it runs however the dialog closes, unmounted included.
 */
import { useCallback, useLayoutEffect, useRef } from "react";

/** The element that has focus now, if any (the body is no element to go back to). */
export function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * Remembers, as the dialog opens, `opener` or else what has focus, and returns an onCloseAutoFocus
 * handler that focuses it again. Focus is left alone when that element is gone from the page, or
 * when something else already has focus (another dialog opened in its place).
 */
export function useReturnFocus(open = true, opener?: HTMLElement | null): (event: Event) => void {
  const target = useRef<HTMLElement | null>(null);
  // Before the dialog's focus scope moves focus inside (a passive effect), so what has focus is
  // still the opener. Once per opening: `opener` changing while it is open changes nothing.
  useLayoutEffect(() => {
    if (open) target.current = opener ?? focusedElement();
  }, [open]);
  return useCallback((event: Event) => {
    const element = target.current;
    target.current = null;
    if (!element?.isConnected || focusedElement() !== null) return;
    event.preventDefault();
    element.focus();
  }, []);
}
