/** Layout: the list/detail split, pane headers, and the loading/error states every pane shares. */
import { clsx } from "clsx";
import { ChevronLeft, CloudOff, RotateCw } from "lucide-react";
import { Link } from "wouter";
import { Component, type ReactNode } from "react";
import type { Resource } from "../data/store.ts";
import { Button } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";

interface SplitViewProps {
  list: ReactNode;
  detail: ReactNode;
  /** On narrow screens only one pane shows: the detail when something is selected. */
  hasDetail: boolean;
  listLabel: string;
  /** Where the phone-width back bar goes when only the detail shows. */
  backHref: string;
}

export function SplitView({ list, detail, hasDetail, listLabel, backHref }: SplitViewProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section aria-label={listLabel} className={clsx("flex min-h-0 w-[340px] shrink-0 flex-col border-r border-line max-lg:w-[300px]", hasDetail ? "max-md:hidden" : "max-md:w-full max-md:border-r-0")}>
        {list}
      </section>
      <section className={clsx("flex min-h-0 min-w-0 flex-1 flex-col", !hasDetail && "max-md:hidden")}>
        {hasDetail && (
          <Link href={backHref} className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-4 text-small text-muted hover:text-ink md:hidden">
            <ChevronLeft className="size-4" /> {listLabel}
          </Link>
        )}
        {detail}
      </section>
    </div>
  );
}

interface PaneHeaderProps {
  title: ReactNode;
  count?: number;
  children?: ReactNode;
  className?: string;
}

export function PaneHeader({ title, count, children, className }: PaneHeaderProps) {
  return (
    <header className={clsx("flex h-11 shrink-0 items-center gap-2 border-b border-line px-4", className)}>
      <h1 className="text-heading">{title}</h1>
      {count !== undefined && <span className="tabular text-small text-muted">{count}</span>}
      {children && <div className="ml-auto flex items-center gap-1.5">{children}</div>}
    </header>
  );
}

interface BoundaryState {
  readonly error: Error | null;
}

/**
 * Catches a screen that failed to load or render (most often a chunk that a rebuild
 * renamed while the tab was open) and offers a reload instead of a blank pane.
 */
export class ScreenBoundary extends Component<{ children: ReactNode; resetKey: string }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidUpdate(previous: { resetKey: string }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        icon={CloudOff}
        title="This screen didn't load"
        actions={
          <Button onClick={() => location.reload()}>
            <RotateCw /> Reload
          </Button>
        }
      >
        The app may have been rebuilt while this tab was open. Reloading fetches the current version.
      </EmptyState>
    );
  }
}

const SKELETON_ROWS = 12;

export function PaneSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-1 flex-col">
      <div className="h-11 border-b border-line" />
      <div className="space-y-2 p-4">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="h-5 rounded-xs bg-raised" style={{ width: `${40 + ((i * 37) % 50)}%`, opacity: 1 - i * 0.06 }} />
        ))}
      </div>
    </div>
  );
}

/** Renders the waiting or failed state of a resource, or nothing once it is ready. */
export function ResourceState<T>({ state, onRetry, what }: { state: Resource<T>; onRetry: () => void; what: string }) {
  if (state.status === "error") {
    return (
      <EmptyState
        icon={CloudOff}
        title={`Couldn't load ${what}`}
        actions={
          <Button onClick={onRetry}>
            <RotateCw /> Try again
          </Button>
        }
      >
        {state.message}
      </EmptyState>
    );
  }
  return <PaneSkeleton />;
}
