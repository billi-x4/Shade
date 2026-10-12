import { Link, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { buttonClass } from "@/components/button-styles";
import { LoadingState } from "@/components/states";
import { PublicPage } from "@/components/site-header";
import { ApiError } from "@/api/client";
import { useDocumentTitle } from "@/lib/hooks";

export function NotFoundPage() {
  useDocumentTitle("Not found");
  return (
    <PublicPage className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <h1 className="font-serif text-4xl sm:text-5xl">Nothing here.</h1>
      <p className="mt-4 text-muted">The link may be mistyped, or the page has moved.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link to="/" className={buttonClass("primary")}>
          Go to the start
        </Link>
        <Link to="/desk/invoices" className={buttonClass("ghost")}>
          Open desk
        </Link>
      </div>
    </PublicPage>
  );
}

/** Route error boundary. Shows a safe message and a reference id, never raw internals. */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useDocumentTitle("Something went wrong");
  const reference = error instanceof ApiError ? error.requestId : null;
  const offline = error instanceof ApiError && error.code === "NETWORK_ERROR";
  return (
    <PublicPage className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <h1 className="font-serif text-4xl sm:text-5xl">
        {offline ? "Shade is out of reach." : "Something went wrong."}
      </h1>
      <p className="mt-4 text-muted">
        {offline
          ? "Check your connection, then try again."
          : "Try again. If it keeps happening, the reference below helps us find it."}
      </p>
      {reference ? (
        <p className="mt-3 text-sm text-faint">
          Reference <code className="text-muted">{reference}</code>
        </p>
      ) : null}
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          className={buttonClass("primary")}
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </button>
        <Link to="/" className={buttonClass("ghost")}>
          Go to the start
        </Link>
      </div>
    </PublicPage>
  );
}

export function RoutePendingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <LoadingState label="Loading…" rows={2} />
    </div>
  );
}
