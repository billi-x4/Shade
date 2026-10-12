/**
 * The desk session, read with a plain same-origin GET of Better Auth's /api/auth/get-session. Route
 * guards and headers only need "who is signed in", so the Better Auth client (api/auth.ts) loads with
 * the auth and desk pages and never with the pay page a payer opens.
 */
import { queryOptions } from "@tanstack/react-query";
import type { createAuthClient } from "better-auth/react";
import { authErrorMessage } from "@/api/auth-errors";
import { ApiError, NETWORK_MESSAGE } from "@/api/client";
import { qk } from "@/api/keys";

type AuthClient = ReturnType<typeof createAuthClient>;
export type AuthSession = NonNullable<Awaited<ReturnType<AuthClient["getSession"]>>["data"]>;

function isSession(value: unknown): value is AuthSession {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { user?: unknown }).user === "object" &&
    typeof (value as { session?: unknown }).session === "object"
  );
}

export const sessionQuery = queryOptions({
  queryKey: qk.session,
  queryFn: async ({ signal }): Promise<AuthSession | null> => {
    let res: Response;
    try {
      res = await fetch("/api/auth/get-session", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal,
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new ApiError({ status: 0, code: "NETWORK_ERROR", message: NETWORK_MESSAGE });
    }
    const data: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const body = (data ?? {}) as { code?: string; message?: string };
      throw new ApiError({
        status: res.status,
        code: res.status === 401 ? "UNAUTHORIZED" : "UNEXPECTED_RESPONSE",
        message: authErrorMessage({ status: res.status, code: body.code, message: body.message }),
      });
    }
    if (data === null) return null;
    if (!isSession(data)) {
      throw new ApiError({
        status: res.status,
        code: "UNEXPECTED_RESPONSE",
        message: "That did not work. Try again.",
      });
    }
    return data;
  },
  staleTime: 30_000,
});
