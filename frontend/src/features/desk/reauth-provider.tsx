import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { authClient, authErrorMessage, sessionQuery } from "@/api/auth";
import { qk } from "@/api/keys";
import { useAnnounce } from "@/components/announcer-context";
import { Button } from "@/components/button";
import { Field, TextInput } from "@/components/field";
import { Modal } from "@/components/modal";
import { ReauthContext, type RequestReauth } from "@/features/desk/desk-context";

/**
 * Sensitive desk actions need a session younger than 15 minutes (403 SESSION_NOT_FRESH). This asks
 * for the password again, signs in afresh, and lets the caller retry the action once.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery);
  const email = session.data?.user.email ?? "";
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const waiting = useRef<{ promise: Promise<boolean>; resolve: (ok: boolean) => void } | null>(
    null,
  );
  const passwordRef = useRef<HTMLInputElement>(null);
  const announce = useAnnounce();
  const titleId = useId();
  const bodyId = useId();

  const requestReauth = useCallback<RequestReauth>(() => {
    if (waiting.current) return waiting.current.promise;
    let resolve: (ok: boolean) => void = () => {};
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    waiting.current = { promise, resolve };
    setPassword("");
    setError(null);
    setOpen(true);
    return promise;
  }, []);

  const finish = (ok: boolean) => {
    waiting.current?.resolve(ok);
    waiting.current = null;
    setOpen(false);
    setPassword("");
  };

  /**
   * Shows the error, puts focus back in the password field (it may be on the submit button) and
   * speaks the error through the dialog's live region, since focus may never have left the field.
   */
  function fail(message: string) {
    setError(message);
    passwordRef.current?.focus();
    announce(message);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!password) {
      fail("Enter your password.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await authClient.signIn.email({ email, password }).catch(() => null);
    setPending(false);
    if (!result || result.error) {
      fail(result?.error ? authErrorMessage(result.error) : "Cannot reach Shade. Try again.");
      return;
    }
    queryClient.removeQueries({ queryKey: qk.session });
    finish(true);
  }

  return (
    <ReauthContext.Provider value={requestReauth}>
      {children}
      <Modal
        open={open}
        onDismiss={pending ? undefined : () => finish(false)}
        labelledBy={titleId}
        describedBy={bodyId}
        initialFocus={passwordRef}
      >
        <form className="space-y-5 p-6" onSubmit={(event) => void onSubmit(event)} noValidate>
          <div className="space-y-3">
            <p className="flex items-center gap-2.5 font-mono text-[0.7rem] tracking-[0.14em] text-faint uppercase">
              <span aria-hidden className="h-1 w-6 rounded-[1px] bg-glow" />
              Password check
            </p>
            <h2 id={titleId} className="font-display text-3xl leading-tight">
              Confirm it is you
            </h2>
            <p id={bodyId} className="text-sm text-muted">
              This change touches money or keys, so Shade asks for your password again. Then it
              finishes what you started.
            </p>
          </div>
          <div className="rounded-sm border border-line bg-bg/60 px-4 py-3">
            <p className="font-mono text-[0.7rem] tracking-[0.14em] text-faint uppercase">
              Signed in as
            </p>
            <p className="mt-1 text-sm wrap-anywhere text-fg">{email}</p>
          </div>
          <Field label="Password" error={error}>
            {(control) => (
              <TextInput
                {...control}
                ref={passwordRef}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
          {/* aria-disabled, not disabled, while checking: a disabled button drops focus out of
              the dialog, and Escape would then bypass the handler that keeps it open. */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              onClick={pending ? undefined : () => finish(false)}
              aria-disabled={pending || undefined}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              aria-disabled={pending || undefined}
              aria-busy={pending || undefined}
            >
              {pending ? "Checking…" : "Confirm and continue"}
            </Button>
          </div>
        </form>
      </Modal>
    </ReauthContext.Provider>
  );
}
