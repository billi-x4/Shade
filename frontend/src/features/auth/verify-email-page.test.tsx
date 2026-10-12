import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnouncerProvider } from "@/components/announcer";
import { LoginPage } from "@/features/auth/login-page";
import { VerifyEmailPage } from "@/features/auth/verify-email-page";

const signIn = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn(async () => ({ data: null, error: null })));

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    signIn: { email: signIn },
    getSession,
    sendVerificationEmail: vi.fn(),
  }),
}));

/** /login and /verify-email under one memory router, as in the app. */
function renderAuthRoutes(start: string) {
  const root = createRootRoute({ component: Outlet });
  const login = createRoute({
    getParentRoute: () => root,
    path: "/login",
    validateSearch: (): { redirect?: string } => ({}),
    component: LoginPage,
  });
  const verify = createRoute({
    getParentRoute: () => root,
    path: "/verify-email",
    validateSearch: (search: Record<string, unknown>): { error?: string } =>
      typeof search.error === "string" ? { error: search.error } : {},
    component: VerifyEmailPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([login, verify]),
    history: createMemoryHistory({ initialEntries: [start] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AnnouncerProvider>
        <RouterProvider router={router} />
      </AnnouncerProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe("verify email", () => {
  it("does not claim a link was sent when sign-in finds the email unconfirmed", async () => {
    signIn.mockResolvedValueOnce({
      data: null,
      error: { code: "EMAIL_NOT_VERIFIED", status: 403, message: "Email not verified" },
    });
    renderAuthRoutes("/login");
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: " shop@example.com " },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Confirm your email first." }),
    ).toBeTruthy();
    expect(
      screen.getByText("Your email is not confirmed yet. Send yourself a new link below."),
    ).toBeTruthy();
    expect(screen.queryByText(/We sent/)).toBeNull();
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("shop@example.com");
    expect(screen.getByRole("button", { name: "Send a new link" })).toBeTruthy();
  });

  it("still says the link is on its way right after sign-up", async () => {
    const router = renderAuthRoutes("/login");
    await screen.findByLabelText("Email");
    await router.navigate({ to: "/verify-email", state: { email: "shop@example.com" } });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Check your inbox." }),
    ).toBeTruthy();
    expect(
      screen.getByText("We sent a link to shop@example.com. Open it, then sign in."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send the link again" })).toBeTruthy();
  });
});
