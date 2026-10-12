import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { NotFoundPage, RouteErrorPage, RoutePendingPage } from "@/components/route-fallbacks";
import { routeTree } from "./routeTree.gen";

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // TanStack Query owns freshness; the router never caches loader data on its own.
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteErrorPage,
    defaultNotFoundComponent: NotFoundPage,
    defaultPendingComponent: RoutePendingPage,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  /** Values handed between auth pages in history state, never in the URL. */
  interface HistoryState {
    email?: string;
    notice?: string;
    /** Sign-in found the email unconfirmed: nothing was just sent, so the page must not say so. */
    reason?: "unverified";
  }
}
