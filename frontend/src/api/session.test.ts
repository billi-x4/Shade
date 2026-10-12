import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError, NETWORK_MESSAGE } from "@/api/client";
import { sessionQuery } from "@/api/session";
import { mockFetch } from "@/test/utils";

const read = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(sessionQuery);

describe("sessionQuery", () => {
  it("reads the session with a same-origin GET", async () => {
    const body = { user: { id: "u_1", email: "shop@example.com" }, session: { id: "s_1" } };
    const { calls } = mockFetch([{ path: "/api/auth/get-session", body }]);
    expect(await read()).toEqual(body);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/auth/get-session" });
    expect(calls[0]!.init).toMatchObject({ credentials: "same-origin" });
  });

  it("is null when signed out", async () => {
    mockFetch([{ path: "/api/auth/get-session", body: null }]);
    expect(await read()).toBeNull();
  });

  it("maps an error status to ApiError with plain words", async () => {
    mockFetch([{ path: "/api/auth/get-session", status: 429, body: { message: "slow down" } }]);
    const error = await read().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "UNEXPECTED_RESPONSE",
      message: "Too many tries. Wait a minute and try again.",
    });
  });

  it("reports a network failure and a body that is not a session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await read().catch((err: unknown) => err)).toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: NETWORK_MESSAGE,
    });
    mockFetch([{ path: "/api/auth/get-session", body: "<html>proxy error</html>" }]);
    expect(await read().catch((err: unknown) => err)).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
    });
  });
});
