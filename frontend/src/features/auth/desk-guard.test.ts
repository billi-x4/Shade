import { QueryClient } from "@tanstack/react-query";
import { defaultParseSearch, isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { Route } from "@/routes/desk";
import { mockFetch } from "@/test/utils";

// Signed out: the plain session read (api/session.ts) answers null.
beforeEach(() => {
  mockFetch([{ path: "/api/auth/get-session", body: null }]);
});

/**
 * Runs the /desk guard for a signed-out visitor arriving at `/desk<query>` and returns where it
 * sends them. The query goes through the router's own search parser, as in the browser.
 */
async function guard(query: string) {
  const search = defaultParseSearch(query);
  const beforeLoad = Route.options.beforeLoad as unknown as (ctx: unknown) => Promise<void>;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await beforeLoad({ context: { queryClient }, location: { pathname: "/desk", search } });
  } catch (thrown) {
    if (isRedirect(thrown)) return thrown.options;
    throw thrown;
  }
  throw new Error("expected a redirect");
}

describe("/desk without a session", () => {
  it("sends a visitor from a working verification link to sign-in with a notice", async () => {
    const target = await guard("?verified=1");
    expect(target).toMatchObject({
      to: "/login",
      state: { notice: "Email confirmed. Sign in to open your desk." },
    });
  });

  it("explains a failed verification link before anything else", async () => {
    expect(await guard("?verified=1&error=INVALID_TOKEN")).toMatchObject({
      to: "/verify-email",
      search: { error: "INVALID_TOKEN" },
    });
  });

  it("asks anyone else to sign in and come back", async () => {
    expect(await guard("")).toMatchObject({ to: "/login", search: { redirect: "/desk" } });
  });
});
