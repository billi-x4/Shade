import { Link, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { buttonClass } from "@/components/button-styles";
import { PublicPage } from "@/components/site-header";
import { ApiError } from "@/api/client";
import { cn } from "@/lib/cn";
import { useDocumentTitle } from "@/lib/hooks";

const EYEBROW = "font-mono text-[0.7rem] tracking-[0.14em] text-faint uppercase";
const SLATS = 9;

/**
 * A blind seen from inside: the slats close over the light behind them. "broken" leaves one slat
 * hanging askew in a warmer light (an error); "dark" has no light behind it (no answer at all).
 */
function Blind({ variant }: { variant: "closed" | "broken" | "dark" }) {
  return (
    <div aria-hidden className="relative">
      {/* Headrail, then the window: light behind, slats in front, a bottom rail. */}
      <span className="relative z-10 block h-3.5 rounded-[3px] border border-line-strong/60 bg-surface-2" />
      <div className="relative isolate mx-3 overflow-hidden">
        {variant === "dark" ? null : (
          <span
            className={cn(
              "blinds-fade absolute inset-0 -z-10",
              variant === "broken" ? "bg-warn/70" : "bg-glow/85",
            )}
          />
        )}
        <div className="grid gap-1.5 pt-1.5">
          {Array.from({ length: SLATS }, (_, index) => (
            <span
              key={index}
              className={cn(
                "block h-6 sm:h-8",
                variant === "broken" && index === 5 && "origin-left translate-y-1.5 rotate-[3deg]",
              )}
            >
              <span
                className="slat-open block h-full rounded-[3px] bg-linear-to-b from-surface-2 to-surface shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]"
                style={{ "--i": index } as CSSProperties}
              />
            </span>
          ))}
          <span className="block h-2.5 rounded-[3px] border border-line-strong/60 bg-surface-2" />
        </div>
      </div>
      {/* The pull cord, down the right side. */}
      <span className="absolute top-3.5 right-9 bottom-[18%] w-px bg-faint/60" />
      <span className="absolute right-[2.05rem] bottom-[calc(18%-0.75rem)] h-3 w-2 rounded-full bg-faint/70" />
    </div>
  );
}

function FallbackPage({
  eyebrow,
  title,
  art,
  children,
}: {
  eyebrow?: string;
  title: string;
  art: ReactNode;
  children: ReactNode;
}) {
  return (
    <PublicPage className="px-4 py-12 sm:px-6 sm:py-20">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-20">
        <div className="max-w-xl space-y-6">
          <div className="space-y-3">
            {eyebrow ? <p className={EYEBROW}>{eyebrow}</p> : null}
            <span aria-hidden className="slat-open block h-1 w-12 rounded-[1px] bg-glow" />
            <h1 className="font-display text-5xl leading-[0.95] sm:text-6xl">{title}</h1>
          </div>
          {children}
        </div>
        {art}
      </div>
    </PublicPage>
  );
}

export function NotFoundPage() {
  useDocumentTitle("Not found");
  return (
    <FallbackPage eyebrow="Error 404" title="Nothing here." art={<Blind variant="closed" />}>
      <p className="text-lg text-muted">Check the link for a typo. The page may also have moved.</p>
      <div className="flex flex-wrap gap-3">
        <Link to="/" className={buttonClass("primary")}>
          Go to the home page
        </Link>
        <Link to="/desk/invoices" className={buttonClass("ghost")}>
          Open desk
        </Link>
      </div>
    </FallbackPage>
  );
}

/** Route error boundary. Shows a safe message and a reference id, never raw internals. */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useDocumentTitle("Something went wrong");
  const reference = error instanceof ApiError ? error.requestId : null;
  const offline = error instanceof ApiError && error.code === "NETWORK_ERROR";
  return (
    <FallbackPage
      title={offline ? "Shade is out of reach." : "Something went wrong."}
      art={<Blind variant={offline ? "dark" : "broken"} />}
    >
      <p className="text-lg text-muted">
        {offline
          ? "Check your connection, then try again."
          : reference
            ? "Try again. If it keeps happening, report it with the reference below."
            : "Try again in a moment."}
      </p>
      {reference ? (
        <div className="space-y-1">
          <p className={EYEBROW}>Reference</p>
          <p>
            <code className="text-sm wrap-anywhere text-fg">{reference}</code>
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
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
          Go to the home page
        </Link>
      </div>
    </FallbackPage>
  );
}

/** While a route loads: a small blind whose middle slat lights up, and a spoken label. */
export function RoutePendingPage() {
  return (
    <div
      role="status"
      className="mx-auto flex min-h-[50dvh] w-full max-w-6xl flex-col justify-center gap-4 px-4 py-16 sm:px-6"
    >
      <span aria-hidden className="grid w-24 gap-2">
        <span className="skeleton block h-2.5 rounded-[2px]" />
        <span className="slat-open block h-2.5 rounded-[2px] bg-glow/85" />
        <span className="skeleton block h-2.5 rounded-[2px]" />
      </span>
      <span className={EYEBROW}>Loading…</span>
    </div>
  );
}
