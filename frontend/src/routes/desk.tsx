import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "@/api/session";
import { DeskShell } from "@/features/desk/desk-shell";

export const Route = createFileRoute("/desk")({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (session) return;
    // A failed email-verification link lands here as /desk…?error=…; explain it instead of a bare sign-in.
    const linkError = (location.search as Record<string, unknown>).error;
    if (typeof linkError === "string")
      throw redirect({ to: "/verify-email", search: { error: linkError } });
    // A working link confirms the email but signs nobody in (`?verified=1`, which the router's
    // search parser reads as the number 1).
    const verified = (location.search as Record<string, unknown>).verified;
    if (verified === 1 || verified === "1")
      throw redirect({
        to: "/login",
        state: { notice: "Email confirmed. Sign in to open your desk." },
      });
    throw redirect({ to: "/login", search: { redirect: location.pathname } });
  },
  component: DeskShell,
});
