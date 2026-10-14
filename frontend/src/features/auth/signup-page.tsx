import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { authClient, authErrorMessage } from "@/api/auth";
import { useAppConfig } from "@/api/config";
import { useAnnounce } from "@/components/announcer-context";
import { Button } from "@/components/button";
import { Field, TextInput } from "@/components/field";
import { AuthLayout, FormMessage } from "@/features/auth/auth-layout";
import { fieldErrorSummary } from "@/features/auth/form-errors";
import { checkPassword, DISPLAY_NAME_MAX } from "@/lib/validation";

const LINK =
  "inline-flex min-h-11 items-center text-sm text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg hover:decoration-accent";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FIELDS = ["name", "email", "password", "confirm"] as const;
type Errors = Partial<Record<(typeof FIELDS)[number], string>>;

export function SignupPage() {
  const config = useAppConfig();
  const navigate = useNavigate();
  const minLength = config.data?.auth.password_min_length ?? 12;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const announce = useAnnounce();
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  function validate(): Errors {
    const next: Errors = {};
    if (name.trim().length > DISPLAY_NAME_MAX)
      next.name = `Keep it under ${DISPLAY_NAME_MAX + 1} characters.`;
    if (!EMAIL_RE.test(email.trim())) next.email = "Enter a valid email address.";
    const passwordError = checkPassword(password, minLength);
    if (passwordError) next.password = passwordError;
    if (confirm !== password) next.confirm = "The passwords do not match.";
    return next;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    setFormError(null);
    const first = FIELDS.find((field) => next[field]);
    if (first) {
      refs[first].current?.focus();
      // Focus may already be in that field (Enter pressed there), so also say what is wrong.
      const summary = fieldErrorSummary(FIELDS.map((field) => next[field]));
      if (summary) announce(summary);
      return;
    }
    setPending(true);
    const result = await authClient.signUp
      .email({ email: email.trim(), password, name: name.trim(), callbackURL: "/desk?verified=1" })
      .catch(() => null);
    setPending(false);
    if (!result || result.error) {
      setFormError(authErrorMessage(result?.error ?? { status: 0 }));
      return;
    }
    if (config.data?.auth.email_verification_required ?? true) {
      await navigate({ to: "/verify-email", state: { email: email.trim() } });
    } else {
      await navigate({
        to: "/login",
        state: { email: email.trim(), notice: "Account created. Sign in to open your desk." },
      });
    }
  }

  return (
    <AuthLayout
      title="Create your desk"
      documentTitle="Create account"
      intro="Send private ZEC invoices and cap what an AI agent can spend. Shade never asks for your seed phrase."
    >
      <form className="space-y-5" onSubmit={(event) => void onSubmit(event)} noValidate>
        <Field
          label="Shop name"
          hint="Optional. Payers see it on your pay pages."
          error={errors.name}
        >
          {(control) => (
            <TextInput
              {...control}
              ref={refs.name}
              autoComplete="organization"
              placeholder="Northline Coffee"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Email" error={errors.email}>
          {(control) => (
            <TextInput
              {...control}
              ref={refs.email}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field
          label="Password"
          hint={`${minLength} to 128 characters. A long phrase is easy to remember.`}
          error={errors.password}
        >
          {(control) => (
            <TextInput
              {...control}
              ref={refs.password}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm password" error={errors.confirm}>
          {(control) => (
            <TextInput
              {...control}
              ref={refs.confirm}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          )}
        </Field>
        <FormMessage error={formError} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Creating…" : "Create account"}
        </Button>
      </form>
      <p className="border-t border-line pt-3 text-sm text-faint">
        Already have an account?{" "}
        <Link to="/login" className={LINK}>
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
