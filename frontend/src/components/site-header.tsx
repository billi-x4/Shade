import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { sessionQuery } from "@/api/session";
import { buttonClass } from "@/components/button-styles";
import { BlindGlyph, Mark } from "@/components/mark";
import { cn } from "@/lib/cn";

const NAV_LINK =
  "inline-flex min-h-11 items-center px-2 text-sm text-muted transition-colors hover:text-fg";

function AccountLinks() {
  const session = useQuery(sessionQuery);
  if (session.data) {
    return (
      <Link to="/desk/invoices" className={buttonClass("primary", "px-4")}>
        Open desk
      </Link>
    );
  }
  return (
    <>
      <Link to="/login" className={NAV_LINK}>
        Sign in
      </Link>
      <Link to="/signup" className={buttonClass("primary", "px-4")}>
        Create account
      </Link>
    </>
  );
}

/** Header for public pages. `minimal` (pay and grant views) shows only the mark: payers need no desk links. */
export function SiteHeader({ minimal = false }: { minimal?: boolean }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2 sm:px-6">
        <Mark />
        {minimal ? null : (
          <nav aria-label="Site" className="flex flex-wrap items-center gap-x-1 gap-y-1">
            <Link
              to="/docs"
              className={NAV_LINK}
              activeProps={{ className: "text-fg underline decoration-accent underline-offset-8" }}
            >
              API docs
            </Link>
            <AccountLinks />
          </nav>
        )}
      </div>
    </header>
  );
}

const FOOTER_LINK =
  "inline-flex min-h-11 items-center text-muted underline-offset-4 transition-colors hover:text-fg hover:underline";

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6">
        <div className="max-w-md space-y-3">
          <p className="flex items-center gap-2.5 font-display text-xl text-fg">
            <BlindGlyph />
            Shade
          </p>
          <p className="text-muted">
            Shade is not a wallet. It never holds a seed or a spending key. ZEC only.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 sm:flex-col sm:gap-0">
          <Link to="/docs" className={FOOTER_LINK}>
            API docs
          </Link>
          <a
            href="https://www.npmjs.com/package/shade-zcash-sdk"
            target="_blank"
            rel="noopener noreferrer"
            className={FOOTER_LINK}
          >
            npm package<span className="sr-only"> (opens in a new tab)</span>
          </a>
          <a
            href="https://github.com/billi-x4/Shade"
            target="_blank"
            rel="noopener noreferrer"
            className={FOOTER_LINK}
          >
            Source on GitHub<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </nav>
      </div>
    </footer>
  );
}

/** Public page frame: header outside <main>, one main landmark, optional footer. */
export function PublicPage({
  children,
  minimal = false,
  footer = true,
  className,
}: {
  children: ReactNode;
  minimal?: boolean;
  footer?: boolean;
  className?: string;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader minimal={minimal} />
      <main id="main" tabIndex={-1} className={cn("w-full flex-1 outline-none", className)}>
        {children}
      </main>
      {footer ? <SiteFooter /> : null}
    </div>
  );
}

/** Moves focus to the main landmark without touching the URL fragment (it carries grant tokens on /view). */
export function SkipLink() {
  return (
    <a
      href="#main"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById("main")?.focus();
      }}
      className="sr-only z-50 rounded-sm bg-accent px-4 py-3 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
    >
      Skip to content
    </a>
  );
}
