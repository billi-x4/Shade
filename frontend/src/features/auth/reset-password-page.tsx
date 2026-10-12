import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { authClient, authErrorMessage } from "@/api/auth";
import { useAppConfig } from "@/api/config";
import { useAnnounce } from "@/components/announcer-context";
import { Button } from "@/components/button";
import { Field, TextInput } from "@/components/field";
import { AuthLayout, FormMessage } from "@/features/auth/auth-layout";
import { fieldErrorSummary } from "@/features/auth/form-errors";
import { checkPassword } from "@/lib/validation";

const route = getRouteApi("/reset-password");

const LINK =
  "inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4 hover:text-fg";

function RequestForm({ expired }: { expired: boolean }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) {
      setError("Enter the email you signed up with.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await authClient
      .requestPasswordReset({ email: email.trim(), redirectTo: "/reset-password" })
      .catch(() => null);
    setPending(false);
    if (!result || result.error) {
      setError(authErrorMessage(result?.error ?? { status: 0 }));
      return;
    }
    // Same answer whether or not the account exists.
    setNotice("If an account uses that email, a reset link is on its way. It works for one hour.");
  }

  return (
    <AuthLayout
      title={expired ? "That reset link did not work." : "Reset your password"}
      documentTitle="Reset password"
      intro={
        expired
          ? "Reset links work once, for one hour. Ask for a new one."
          : "We email you a link to choose a new password. Saving it signs you out on every device."
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
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Sending…" : "Email me a reset link"}
        </Button>
      </form>
      <Link to="/login" className={LINK}>
        Back to sign in
      </Link>
    </AuthLayout>
  );
}

function NewPasswordForm({ token }: { token: string }) {
  const config = useAppConfig();
  const navigate = useNavigate();
  const minLength = config.data?.auth.password_min_length ?? 12;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const announce = useAnnounce();
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = {
      password: checkPassword(password, minLength) ?? undefined,
      confirm: confirm === password ? undefined : "The passwords do not match.",
    };
    setErrors(next);
    setFormError(null);
    if (next.password || next.confirm) {
      (next.password ? passwordRef : confirmRef).current?.focus();
      // Focus may already be in that field (Enter pressed there), so also say what is wrong.
      const summary = fieldErrorSummary([next.password, next.confirm]);
      if (summary) announce(summary);
      return;
    }
    setPending(true);
    const result = await authClient
      .resetPassword({ newPassword: password, token })
      .catch(() => null);
    setPending(false);
    if (!result || result.error) {
      setFormError(authErrorMessage(result?.error ?? { status: 0 }));
      return;
    }
    await navigate({
      to: "/login",
      state: { notice: "Password saved. Sign in with it." },
    });
  }

  return (
    <AuthLayout title="Choose a new password" documentTitle="New password">
      <form className="space-y-5" onSubmit={(event) => void onSubmit(event)} noValidate>
        <Field
          label="New password"
          hint={`At least ${minLength} characters.`}
          error={errors.password}
        >
          {(control) => (
            <TextInput
              {...control}
              ref={passwordRef}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm new password" error={errors.confirm}>
          {(control) => (
            <TextInput
              {...control}
              ref={confirmRef}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          )}
        </Field>
        <FormMessage error={formError} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Saving…" : "Save new password"}
        </Button>
      </form>
    </AuthLayout>
  );
}

/**
 * `?token=` arrives from the reset email. It is read once into memory and removed from the
 * address bar, so it does not linger in history or leak through later navigation.
 */
export function ResetPasswordPage() {
  const { token: urlToken, error } = route.useSearch();
  const navigate = useNavigate();
  const [token] = useState(urlToken ?? null);

  useEffect(() => {
    if (urlToken) void navigate({ to: "/reset-password", search: {}, replace: true });
  }, [urlToken, navigate]);

  if (token) return <NewPasswordForm token={token} />;
  return <RequestForm expired={Boolean(error)} />;
}
