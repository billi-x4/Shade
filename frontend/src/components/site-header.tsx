import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { sessionQuery } from "@/api/session";
import { buttonClass } from "@/components/button-styles";
import { Mark } from "@/components/mark";
import { cn } from "@/lib/cn";

const NAV_LINK = "inline-flex min-h-11 items-center px-2 text-sm text-muted hover:text-fg";

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
    <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 sm:px-6">
      <Mark />
      {minimal ? null : (
        <nav aria-label="Site" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to="/docs" className={NAV_LINK} activeProps={{ className: "text-fg" }}>
            API
          </Link>
          <AccountLinks />
        </nav>
      )}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-6xl border-t border-line px-4 py-8 text-sm text-faint sm:px-6">
      <p>Shade is not a wallet. It never holds a seed or a spending key. ZEC only.</p>
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
      className="sr-only z-50 rounded-sm bg-paper px-4 py-3 text-sm font-medium text-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
    >
      Skip to content
    </a>
  );
}
