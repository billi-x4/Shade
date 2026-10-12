import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { AnnouncerProvider } from "@/components/announcer";

export interface MockRoute {
  method?: string;
  path: string | RegExp;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Answer only the first matching request; later ones fall through to the next route. */
  once?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  init: RequestInit | undefined;
}

/** Stubs global fetch with fixed routes. Unmatched requests answer 404 so tests fail loudly. */
export function mockFetch(routes: MockRoute[]) {
  const calls: RecordedRequest[] = [];
  const used = new Set<MockRoute>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname + url.search, body, init });
    const route = routes.find(
      (candidate) =>
        !used.has(candidate) &&
        (candidate.method ?? "GET") === method &&
        (typeof candidate.path === "string"
          ? candidate.path === url.pathname
          : candidate.path.test(url.pathname)),
    );
    if (!route) return new Response("not mocked", { status: 404 });
    if (route.once) used.add(route);
    const headers = { "content-type": "application/json", ...route.headers };
    const payload =
      typeof route.body === "string" || route.body === undefined
        ? (route.body ?? null)
        : JSON.stringify(route.body);
    return new Response(payload, { status: route.status ?? 200, headers });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function testQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

export function renderWithQuery(ui: ReactElement) {
  const client = testQueryClient();
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

/** Like renderWithQuery, inside the app's live-region announcer. */
export function renderWithAnnouncer(ui: ReactElement) {
  return renderWithQuery(<AnnouncerProvider>{ui}</AnnouncerProvider>);
}

/** For components that use Link or useNavigate: a one-route memory router around `ui`. */
export function renderWithRouter(ui: ReactElement) {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { router, ...renderWithAnnouncer(<RouterProvider router={router} />) };
}

/** The text of the polite live region a screen reader would hear right now (the topmost one). */
export function liveRegionText(): string {
  const dialogs = [...document.querySelectorAll("dialog")].filter((dialog) => dialog.open);
  const scope = dialogs.at(-1) ?? document.body;
  const regions = [...scope.querySelectorAll('[role="status"][aria-live="polite"]')];
  return regions.map((region) => region.textContent ?? "").join(" ");
}
