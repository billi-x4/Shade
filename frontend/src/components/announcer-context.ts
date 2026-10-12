import { createContext, useContext } from "react";

export type Announce = (message: string) => void;

export interface LiveRegions {
  /** A modal's own live region, stacked on top while the modal is open. */
  register: (region: HTMLElement) => void;
  unregister: (region: HTMLElement) => void;
}

export const AnnouncerContext = createContext<Announce>(() => {});

export const LiveRegionContext = createContext<LiveRegions>({
  register: () => {},
  unregister: () => {},
});

/**
 * Speaks a message through the app's polite live region, or through the topmost open modal's
 * region while one is open (showModal makes everything outside the dialog inert).
 */
export function useAnnounce(): Announce {
  return useContext(AnnouncerContext);
}

export function useLiveRegions(): LiveRegions {
  return useContext(LiveRegionContext);
}
