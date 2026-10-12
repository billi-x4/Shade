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
  "flex min-h-11 shrink-0 items-center rounded-sm px-3 text-sm whitespace-nowrap text-muted hover:bg-surface hover:text-fg data-[status=active]:bg-surface data-[status=active]:text-fg";

export function SettingsLayout() {
  return (
    <div className="space-y-8">
      <h1 className="font-serif text-4xl leading-tight sm:text-5xl">Settings</h1>
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
        <h2 className="font-serif text-3xl">{title}</h2>
        {intro ? <div className="text-muted">{intro}</div> : null}
      </div>
      {children}
    </section>
  );
}
