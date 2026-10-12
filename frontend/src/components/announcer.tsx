import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import {
  AnnouncerContext,
  LiveRegionContext,
  type Announce,
  type LiveRegions,
} from "@/components/announcer-context";

/** Clear first, then write after this delay, so an identical message is announced again. */
const ANNOUNCE_DELAY_MS = 60;

/**
 * The app's polite live region. Inline status text next to each control is visual; screen readers
 * hear outcomes through here, once. A modal <dialog> opened with showModal() makes this region
 * inert, so each open Modal registers a region of its own and announcements go to the topmost one.
 * The regions are written directly (React renders them empty), so a message always lands in the
 * region that is in the accessibility tree at the moment it is written.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLElement[]>([]);
  const last = useRef<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const announce = useCallback<Announce>((next) => {
    window.clearTimeout(timer.current);
    if (last.current) last.current.textContent = "";
    timer.current = window.setTimeout(() => {
      const target = stack.current.at(-1) ?? root.current;
      if (!target) return;
      target.textContent = next;
      last.current = target;
    }, ANNOUNCE_DELAY_MS);
  }, []);

  const regions = useMemo<LiveRegions>(
    () => ({
      register: (region) => {
        stack.current = [...stack.current.filter((item) => item !== region), region];
      },
      unregister: (region) => {
        stack.current = stack.current.filter((item) => item !== region);
        if (last.current === region) last.current = null;
      },
    }),
    [],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <LiveRegionContext.Provider value={regions}>
      <AnnouncerContext.Provider value={announce}>
        {children}
        <div ref={root} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />
      </AnnouncerContext.Provider>
    </LiveRegionContext.Provider>
  );
}
