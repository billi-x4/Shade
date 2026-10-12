import { useEffect, useState } from "react";

/** Current time, re-rendered every `intervalMs` (for countdowns and relative times). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Per-route document title (WCAG 2.4.2). */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title === "Shade" ? title : `${title} · Shade`;
  }, [title]);
}
