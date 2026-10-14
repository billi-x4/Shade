import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { authClient, authErrorMessage, sessionQuery } from "@/api/auth";
import { Button } from "@/components/button";
import { Field, TextInput } from "@/components/field";
import { AuthLayout, FormMessage } from "@/features/auth/auth-layout";

const route = getRouteApi("/verify-email");

const LINK =
  "inline-flex min-h-11 items-center text-sm text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg hover:decoration-accent";

export function VerifyEmailPage() {
  const { error: linkError } = route.useSearch();
  const state = useRouterState({ select: (s) => s.location.state });
  const session = useQuery(sessionQuery);
  const known = state.email ?? session.data?.user.email ?? "";
  // Also a signed-in account the desk refused (EMAIL_UNVERIFIED): no link was sent on the way here.
  const unverified =
    state.reason === "unverified" || (!state.email && session.data?.user.emailVerified === false);
  const [email, setEmail] = useState(known);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) {
      setError("Enter the email you signed up with.");
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    const result = await authClient
      .sendVerificationEmail({ email: email.trim(), callbackURL: "/desk?verified=1" })
      .catch(() => null);
    setPending(false);
    if (!result || result.error) {
      setError(authErrorMessage(result?.error ?? { status: 0 }));
      return;
    }
    setNotice("Sent. Check your inbox. The link works for one hour.");
  }

  return (
    <AuthLayout
      title={
        linkError
          ? "That link did not work."
          : unverified
            ? "Confirm your email first."
            : "Check your inbox."
      }
      documentTitle="Verify your email"
      intro={
        linkError
          ? "Verification links work once, for one hour. Send yourself a new one."
          : unverified
            ? "Your email is not confirmed yet. Send yourself a new link below."
            : known
              ? `We sent a link to ${known}. Open it, then sign in.`
              : "We sent you a link. Open it, then sign in."
      }
    >
      <form className="space-y-5" onSubmit={(event) => void onSubmit(event)} noValidate>
        <Field label="Email">
          {(control) => (
            <TextInput
              {...control}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <FormMessage error={error} notice={notice} />
        <Button type="submit" variant="ghost" className="w-full" disabled={pending}>
          {pending ? "Sending…" : unverified ? "Send a new link" : "Send the link again"}
        </Button>
      </form>
      <p className="border-t border-line pt-3 text-sm text-faint">
        Confirmed already?{" "}
        <Link to="/login" className={LINK}>
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
