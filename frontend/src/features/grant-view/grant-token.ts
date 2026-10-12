import { useEffect, useState } from "react";

const TOKEN_RE = /^gv_[A-Za-z0-9_-]{16,128}$/;

/** The grant token from a `#gv_…` fragment, or null. */
export function tokenFromHash(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  return TOKEN_RE.test(value) ? value : null;
}

function clearFragment(): void {
  const { pathname, search } = window.location;
  // Keep the router's history state; drop only the fragment so the token leaves the address bar.
  window.history.replaceState(window.history.state, "", `${pathname}${search}`);
}

/**
 * Reads the grant token from the URL fragment once, keeps it in memory only (the view refetches
 * with it), and removes it from the address bar and history entry. A new `#gv_…` fragment pasted
 * into the same tab replaces it.
 */
export function useGrantToken(): string | null {
  const [token, setToken] = useState<string | null>(() => tokenFromHash(window.location.hash));

  useEffect(() => {
    if (tokenFromHash(window.location.hash)) clearFragment();
    const onHashChange = () => {
      const next = tokenFromHash(window.location.hash);
      if (!next) return;
      setToken(next);
      clearFragment();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return token;
}
