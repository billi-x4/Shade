import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RootLayout } from "@/components/root-layout";

/**
 * Stand-ins on the app's own paths: two pages with their own main and h1, and a settings area
 * whose menu sits inside main and outlives a change of section.
 */
function renderApp() {
  const root = createRootRoute({ component: RootLayout });
  const page = (path: "/" | "/docs", title: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => (
        <>
          <nav>
            <Link to="/docs">Header link</Link>
          </nav>
          <main id="main" tabIndex={-1}>
            <h1>{title}</h1>
          </main>
        </>
      ),
    });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/desk/settings",
    component: () => (
      <main id="main" tabIndex={-1}>
        <h1>Settings</h1>
        <Link to="/desk/settings/detection">Detection</Link>
        <Outlet />
      </main>
    ),
  });
  const section = (path: "address" | "detection", title: string) =>
    createRoute({ getParentRoute: () => settings, path, component: () => <h2>{title}</h2> });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/", "Home"),
      page("/docs", "Other page"),
      settings.addChildren([
        section("address", "Receive addresses"),
        section("detection", "Detection settings"),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("focus after navigation", () => {
  it("leaves focus alone on the first load", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus to the new page's h1 without making it a tab stop for good", async () => {
    const router = renderApp();
    (await screen.findByRole("link", { name: "Header link" })).focus();
    await act(() => router.navigate({ to: "/docs" }));

    const heading = await screen.findByRole("heading", { level: 1, name: "Other page" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
    act(() => heading.blur());
    expect(heading.hasAttribute("tabindex")).toBe(false);
  });

  it("keeps focus on an in-page menu link that survives the navigation", async () => {
    const router = renderApp();
    await act(() => router.navigate({ to: "/desk/settings/address" }));
    expect(await screen.findByRole("heading", { name: "Receive addresses" })).toBeTruthy();

    const menuLink = screen.getByRole("link", { name: "Detection" });
    menuLink.focus();
    await act(() => router.navigate({ to: "/desk/settings/detection" }));
    expect(await screen.findByRole("heading", { name: "Detection settings" })).toBeTruthy();
    expect(document.activeElement).toBe(menuLink);
  });
});
