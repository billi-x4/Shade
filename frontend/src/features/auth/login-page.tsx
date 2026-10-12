import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { authClient, authErrorMessage } from "@/api/auth";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { Field, TextInput } from "@/components/field";
import { AuthLayout, FormMessage } from "@/features/auth/auth-layout";
import { safeDeskRedirect } from "@/lib/validation";

const route = getRouteApi("/login");

const LINK =
  "inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4 hover:text-fg";

export function LoginPage() {
  const { redirect } = route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const state = useRouterState({ select: (s) => s.location.state });
  const [email, setEmail] = useState(state.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await authClient.signIn
      .email({ email: email.trim(), password })
      .catch(() => null);
    setPending(false);
    if (!result) {
      setError(authErrorMessage({ status: 0 }));
      return;
    }
    if (result.error) {
      if (result.error.code === "EMAIL_NOT_VERIFIED") {
        // Signing in sends no email, so the next page must not say a link is on its way.
        await navigate({
          to: "/verify-email",
          state: { email: email.trim(), reason: "unverified" },
        });
        return;
      }
      setError(authErrorMessage(result.error));
      return;
    }
    queryClient.removeQueries({ queryKey: qk.session });
    queryClient.removeQueries({ queryKey: qk.desk });
    await navigate({ href: safeDeskRedirect(redirect) ?? "/desk/invoices", replace: true });
  }

  return (
    <AuthLayout title="Sign in to your desk" documentTitle="Sign in">
      <form className="space-y-5" onSubmit={(event) => void onSubmit(event)} noValidate>
        <Field label="Email">
          {(control) => (
            <TextInput
              {...control}
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {(control) => (
            <TextInput
              {...control}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        <FormMessage error={error} notice={state.notice} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <div className="flex flex-wrap justify-between gap-3">
        <Link to="/reset-password" className={LINK}>
          Forgot your password?
        </Link>
        <Link to="/signup" className={LINK}>
          Create an account
        </Link>
      </div>
    </AuthLayout>
  );
}
