import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordPage } from "@/features/auth/reset-password-page";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    ...(typeof search.token === "string" ? { token: search.token } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  component: ResetPasswordPage,
});
