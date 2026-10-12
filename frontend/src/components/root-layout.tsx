import { Outlet, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { AnnouncerProvider } from "@/components/announcer";
import { focusPageStart } from "@/components/page-focus";
import { SkipLink } from "@/components/site-header";

/**
 * After a client-side navigation to another path has rendered, focus moves to the new page's h1
 * (else the main landmark), so keyboard and screen-reader users start at the new content. Not on
 * the first load (fromLocation is unset or the path is unchanged), and not when focus is still on
 * a control inside <main> that outlived the navigation (the Settings menu keeps its place).
 */
function useFocusOnNavigation() {
  const router = useRouter();
  useEffect(
    () =>
      router.subscribe("onRendered", (event) => {
        if (!event.fromLocation || !event.pathChanged) return;
        const main = document.getElementById("main");
        const active = document.activeElement;
        if (active && active !== main && active.isConnected && main?.contains(active)) return;
        focusPageStart();
      }),
    [router],
  );
}

export function RootLayout() {
  useFocusOnNavigation();
  return (
    <AnnouncerProvider>
      <SkipLink />
      <Outlet />
    </AnnouncerProvider>
  );
}
