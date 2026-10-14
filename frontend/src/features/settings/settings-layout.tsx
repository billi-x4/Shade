import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDocumentTitle } from "@/lib/hooks";

const SECTIONS = [
  { to: "/desk/settings/address", label: "Receive addresses & network" },
  { to: "/desk/settings/profile", label: "Profile" },
  { to: "/desk/settings/detection", label: "Detection" },
  { to: "/desk/settings/tags", label: "Tags" },
  { to: "/desk/settings/keys", label: "API keys" },
] as const;

const LINK =
  "flex min-h-11 shrink-0 items-center rounded-sm px-3 text-sm font-medium whitespace-nowrap text-muted transition-colors hover:bg-surface hover:text-fg data-[status=active]:bg-surface data-[status=active]:text-fg data-[status=active]:shadow-[inset_0_-3px_0_var(--color-accent)] lg:data-[status=active]:shadow-[inset_3px_0_0_var(--color-accent)]";

export function SettingsLayout() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <span aria-hidden className="slat-open block h-1 w-12 rounded-[1px] bg-glow" />
        <h1 className="font-display text-5xl leading-[0.95] sm:text-6xl">Settings</h1>
      </div>
      <div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="Settings" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
          <ul className="flex gap-1 lg:flex-col">
            {SECTIONS.map((section) => (
              <li key={section.to}>
                <Link to={section.to} className={LINK}>
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/** One settings section: its title (document title too), an explanation, and content. */
export function SettingsSection({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(`${title} · Settings`);
  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h2 className="font-display text-3xl sm:text-4xl">{title}</h2>
        {intro ? <div className="text-muted">{intro}</div> : null}
      </div>
      {children}
    </section>
  );
}
