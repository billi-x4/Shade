import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { ApiError, errorMessage } from "@/api/client";
import { useAnnounce } from "@/components/announcer-context";
import { useRequestReauth, type RequestReauth } from "@/features/desk/desk-context";

/** Runs `fn`; on 403 SESSION_NOT_FRESH asks for the password once and retries. */
export async function withFreshSession<T>(fn: () => Promise<T>, reauth: RequestReauth): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && error.code === "SESSION_NOT_FRESH" && (await reauth())) {
      return fn();
    }
    throw error;
  }
}

/**
 * A desk mutation with the shared behaviour: fresh-session retry, cache invalidation per the
 * invalidation map, and one spoken outcome through the polite live region.
 */
export function useDeskMutation<TData, TVars = void>(options: {
  mutationFn: (vars: TVars) => Promise<TData>;
  invalidate?: (data: TData, vars: TVars) => QueryKey[];
  success?: (data: TData, vars: TVars) => string | null;
  onSuccess?: (data: TData, vars: TVars) => void;
}) {
  const queryClient = useQueryClient();
  const reauth = useRequestReauth();
  const announce = useAnnounce();
  return useMutation<TData, unknown, TVars>({
    mutationFn: (vars) => withFreshSession(() => options.mutationFn(vars), reauth),
    onSuccess: (data, vars) => {
      for (const queryKey of options.invalidate?.(data, vars) ?? []) {
        void queryClient.invalidateQueries({ queryKey });
      }
      options.onSuccess?.(data, vars);
      const message = options.success?.(data, vars);
      if (message) announce(message);
    },
    onError: (error) => announce(errorMessage(error)),
  });
}
