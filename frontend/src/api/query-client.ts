import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";

export interface AuthFailureHandlers {
  /** The session is gone (401): clear it and send the merchant to sign in. */
  onUnauthorized: () => void;
  /** The account exists but its email is not verified yet (403 EMAIL_UNVERIFIED). */
  onEmailUnverified: () => void;
}

function routeAuthFailure(error: unknown, handlers: AuthFailureHandlers): void {
  if (!(error instanceof ApiError)) return;
  if (error.status === 401) handlers.onUnauthorized();
  else if (error.code === "EMAIL_UNVERIFIED") handlers.onEmailUnverified();
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  // Client errors (4xx) are answers, not outages: retrying cannot change them.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(handlers: AuthFailureHandlers): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: (error) => routeAuthFailure(error, handlers) }),
    mutationCache: new MutationCache({ onError: (error) => routeAuthFailure(error, handlers) }),
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 5_000, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}
