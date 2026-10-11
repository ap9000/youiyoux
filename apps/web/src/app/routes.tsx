/** Route table: every screen is its own chunk, preloaded on hover/focus and on idle after first paint. */
import { Boxes, House, KeyRound, type LucideIcon, Monitor, Palette, GitPullRequestArrow } from "lucide-react";
import { type ComponentType, createElement } from "react";

/**
 * A screen whose chunk can be preloaded. Unlike React.lazy, once the chunk has arrived it
 * renders synchronously, so a preloaded route never suspends (React holds a suspended
 * route's fallback for at least 300 ms, which would blow the navigation budget).
 */
export function preloadable<M, P extends object>(load: () => Promise<M>, pick: (module: M) => ComponentType<P>): { Component: ComponentType<P>; preload: () => Promise<void> } {
  let Loaded: ComponentType<P> | null = null;
  let failure: unknown = null;
  let pending: Promise<void> | null = null;
  const preload = (): Promise<void> =>
    (pending ??= load().then(
      (module) => {
        Loaded = pick(module);
        failure = null;
      },
      (error: unknown) => {
        // Forget the failed attempt so the next render or hover tries again.
        failure = error;
        pending = null;
      },
    ));
  function Component(props: P) {
    if (Loaded) return createElement(Loaded, props);
    if (failure) {
      const error = failure;
      failure = null;
      throw error;
    }
    throw preload();
  }
  return { Component, preload };
}

const home = preloadable(() => import("../screens/home/HomeScreen.tsx"), (m) => m.HomeScreen);
const catalog = preloadable(() => import("../screens/catalog/CatalogScreen.tsx"), (m) => m.CatalogScreen);
const tokens = preloadable(() => import("../screens/tokens/TokensScreen.tsx"), (m) => m.TokensScreen);
const screens = preloadable(() => import("../screens/screens/ScreensScreen.tsx"), (m) => m.ScreensScreen);
const loadStubs = () => import("../screens/stubs/StubScreens.tsx");
const changes = preloadable(loadStubs, (m) => m.ChangesScreen);
const access = preloadable(loadStubs, (m) => m.AccessScreen);
const notFound = preloadable(loadStubs, (m) => m.NotFoundScreen);

export const HomeScreen = home.Component;
export const CatalogScreen = catalog.Component;
export const TokensScreen = tokens.Component;
export const ScreensScreen = screens.Component;
export const ChangesScreen = changes.Component;
export const AccessScreen = access.Component;
export const NotFoundScreen = notFound.Component;

const loaders = {
  home: home.preload,
  catalog: catalog.preload,
  tokens: tokens.preload,
  screens: screens.preload,
  stubs: () => Promise.all([changes, access, notFound].map((s) => s.preload())).then(() => undefined),
} as const;

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The `g` chord key that jumps here. */
  readonly key: string;
  readonly loader: keyof typeof loaders;
}

export const NAV: readonly NavItem[] = [
  { href: "/", label: "Home", icon: House, key: "h", loader: "home" },
  { href: "/elements", label: "Elements", icon: Boxes, key: "e", loader: "catalog" },
  { href: "/tokens", label: "Tokens", icon: Palette, key: "t", loader: "tokens" },
  { href: "/screens", label: "Screens", icon: Monitor, key: "s", loader: "screens" },
  { href: "/changes", label: "Changes", icon: GitPullRequestArrow, key: "c", loader: "stubs" },
  { href: "/access", label: "Access", icon: KeyRound, key: "a", loader: "stubs" },
];

export function isActive(item: NavItem, path: string): boolean {
  return item.href === "/" ? path === "/" : path === item.href || path.startsWith(`${item.href}/`);
}

/** Start loading the chunk behind `href` (safe to call repeatedly; imports are cached). */
export function preload(href: string): void {
  const item = [...NAV].reverse().find((n) => isActive(n, href));
  if (item) void loaders[item.loader]();
}

export function preloadAll(): void {
  for (const load of Object.values(loaders)) void load();
}
