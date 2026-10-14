import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LogOut, Settings } from "lucide-react";
import { Fragment, useState } from "react";
import { authClient } from "@/api/auth";
import { meQuery } from "@/api/desk";
import { Mark, NetworkBadge } from "@/components/mark";
import { ReauthProvider } from "@/features/desk/reauth-provider";
import { SecretProvider } from "@/features/desk/secret-provider";

/** PRD §7: the merchant dashboard nav is exactly "Invoices · Jars · Grants · Webhooks". */
const PRIMARY = [
  { to: "/desk/invoices", label: "Invoices" },
  { to: "/desk/jars", label: "Jars" },
  { to: "/desk/grants", label: "Grants" },
  { to: "/desk/webhooks", label: "Webhooks" },
] as const;

const NAV_LINK =
  "relative inline-flex min-h-11 items-center px-1.5 text-sm font-medium text-muted transition-colors after:absolute after:inset-x-1.5 after:bottom-1 after:h-[3px] after:origin-left after:scale-x-0 after:rounded-[1px] after:bg-accent after:transition-transform after:duration-300 hover:text-fg data-[status=active]:text-fg data-[status=active]:after:scale-x-100";

const TOOL_LINK =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-sm px-2 text-sm text-muted transition-colors hover:text-fg";

function SignOutButton() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={TOOL_LINK}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void authClient
          .signOut()
          .catch(() => null)
          .then(() => {
            queryClient.clear();
            return navigate({ to: "/" });
          });
      }}
    >
      <LogOut aria-hidden size={18} strokeWidth={1.75} />
      <span className="max-sm:sr-only">{pending ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}

function DeskHeader() {
  const me = useQuery(meQuery);
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-8 gap-y-1 px-4 py-2 sm:px-6">
        <Mark />
        <nav aria-label="Desk" className="order-last w-full sm:order-none sm:w-auto">
          <ul className="flex items-center gap-1">
            {PRIMARY.map((item, index) => (
              <Fragment key={item.to}>
                {index > 0 ? (
                  <li aria-hidden className="text-faint">
                    ·
                  </li>
                ) : null}
                <li>
                  <Link to={item.to} className={NAV_LINK}>
                    {item.label}
                  </Link>
                </li>
              </Fragment>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-1">
          {me.data ? <NetworkBadge network={me.data.merchant.network} /> : null}
          <Link to="/desk/settings" className={TOOL_LINK} activeProps={{ className: "text-fg" }}>
            <Settings aria-hidden size={18} strokeWidth={1.75} />
            <span className="max-sm:sr-only">Settings</span>
          </Link>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

/** The operator turned off the network the desk is on: say so on every page, with the fix. */
function NetworkOffBanner() {
  const me = useQuery(meQuery);
  if (!me.data || me.data.networks_enabled.includes(me.data.merchant.network)) return null;
  return (
    <div className="border-b border-warn/40 bg-warn/5">
      <p className="mx-auto w-full max-w-6xl px-4 py-2 text-sm text-warn sm:px-6">
        This server has turned {me.data.merchant.network} off, so new invoices, jars and keys fail.{" "}
        <Link to="/desk/settings/address" className="text-fg underline underline-offset-4">
          Switch networks
        </Link>
      </p>
    </div>
  );
}

/** Signed-in frame: header outside <main>, the shared re-auth and shown-once secret dialogs. */
export function DeskShell() {
  return (
    <ReauthProvider>
      <SecretProvider>
        <div className="flex min-h-dvh flex-col">
          <DeskHeader />
          <NetworkOffBanner />
          <main
            id="main"
            tabIndex={-1}
            className="safe-bottom mx-auto w-full max-w-6xl flex-1 px-4 pt-8 outline-none sm:px-6 sm:pt-10"
          >
            <Outlet />
          </main>
        </div>
      </SecretProvider>
    </ReauthProvider>
  );
}
