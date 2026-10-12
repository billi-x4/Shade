import { createFileRoute } from "@tanstack/react-router";
import { VerifyEmailPage } from "@/features/auth/verify-email-page";

export const Route = createFileRoute("/verify-email")({
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  component: VerifyEmailPage,
});
