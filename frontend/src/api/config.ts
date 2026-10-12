import type { AppConfig } from "@shade/contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/keys";

export const configQuery = queryOptions({
  queryKey: qk.config,
  queryFn: ({ signal }) => api.get<AppConfig>("/api/config", signal),
  staleTime: Infinity,
});

export function useAppConfig() {
  return useQuery(configQuery);
}
