/**
 * The rule editor's session key for this run. `youi ui --project` prints a link carrying it
 * in the fragment (never sent in a request); the hub keeps it for the tab and takes it out of
 * the address bar. Captured at startup, so the link may open any page of the hub.
 */
const KEY_STORE = "youiyoux.editor-key";

export function sessionKey(): string | null {
  const match = /(?:^#|&)key=([\w-]+)/.exec(location.hash);
  try {
    if (match) {
      sessionStorage.setItem(KEY_STORE, match[1]!);
      history.replaceState(history.state, "", location.pathname + location.search);
    }
    return sessionStorage.getItem(KEY_STORE);
  } catch {
    return match?.[1] ?? null;
  }
}
