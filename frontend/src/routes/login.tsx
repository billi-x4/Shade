import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "@/api/session";
import { LoginPage } from "@/features/auth/login-page";
import { safeDeskRedirect } from "@/lib/validation";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = typeof search.redirect === "string" ? safeDeskRedirect(search.redirect) : null;
    return target ? { redirect: target } : {};
  },
  beforeLoad: async ({ context }) => {
    // Already signed in: go straight to the desk. If the session check fails, show the form anyway.
    const session = await context.queryClient.fetchQuery(sessionQuery).catch(() => null);
    if (session) throw redirect({ to: "/desk/invoices" });
  },
  component: LoginPage,
});
