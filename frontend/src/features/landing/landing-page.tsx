import { COPY } from "@shade/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { sessionQuery } from "@/api/session";
import { buttonClass } from "@/components/button-styles";
import { PublicPage } from "@/components/site-header";
import { useDocumentTitle } from "@/lib/hooks";

/** COPY.tagline set as three lines: "Pay in the dark." / "Prove in the light." / "Keys stay yours." */
const TAGLINE_LINES = COPY.tagline.split(/(?<=\.)\s+/);

const OBJECTS = [
  {
    name: "Invoice",
    example: "0.01 ZEC · Order 1042",
    body: "“Pay this much ZEC for this memo.” A pay page, a QR and a link the payer's wallet already understands.",
  },
  {
    name: "Jar",
    example: "Cap 0.006 ZEC",
    body: "A spending limit for an AI agent. It spends up to the cap, then fails closed. Kill it any time.",
  },
  {
    name: "Grant",
    example: "10 minutes · payroll",
    body: "A time-boxed receipt view for an accountant. Revoke it and the view goes dark.",
  },
  {
    name: "Tag",
    example: "northline.shade",
    body: "A short name that points at your Unified Address, so people can find where to pay you.",
  },
] as const;

const LOOP = [
  {
    title: "Invoice",
    body: "Create a 0.01 ZEC invoice on the desk. Shade returns a pay page and a ZIP-321 payment link.",
  },
  {
    title: "Pay",
    body: "The payer scans the QR and sends from a shielded wallet. An explorer shows a shielded transaction: not who, not how much.",
  },
  {
    title: "Paid",
    body: "Shade finds the payment with your viewing key. The pay page and the desk flip to Paid, and your server gets a signed invoice.paid webhook.",
  },
  {
    title: "Grant",
    body: "Open a 10-minute grant. Your accountant sees the receipt and downloads the CSV. Revoke it: the view and the download go dark.",
  },
  {
    title: "Jar",
    body: "Give an agent a jar capped at 0.006 ZEC. It pays three times 0.002. The fourth call is refused: the jar is empty.",
  },
] as const;

const LIMITS: ReactNode[] = [
  "Shade is not a wallet. It never holds a seed or a spending key, and transparent addresses are refused.",
  <>
    {COPY.jarIsLimit} Kill: {COPY.killNote}
  </>,
  COPY.grantNote,
  COPY.lag,
  "Automatic detection needs a full viewing key, which also shows outgoing payments. Use a receive-only account, or run the scanner on your own machine.",
  COPY.chainPrivacyNote,
  "A payment that moves between Zcash pools shows the amount that crosses. One shop address links that shop's pay pages for anyone who compares them.",
  COPY.quantum,
];

/** Signed-out visitors get the sign-up, like the header; a signed-in merchant goes straight in. */
function HeroActions() {
  const session = useQuery(sessionQuery);
  return (
    <div className="flex flex-col gap-3 pt-2 sm:flex-row">
      {session.data ? (
        <Link to="/desk/invoices" className={buttonClass("primary")}>
          Open the desk
        </Link>
      ) : (
        <Link to="/signup" className={buttonClass("primary")}>
          Create account
        </Link>
      )}
      <Link to="/docs" className={buttonClass("ghost")}>
        Read the API
      </Link>
    </div>
  );
}

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="mx-auto grid w-full max-w-6xl gap-8 border-t border-line px-4 py-16 sm:px-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-16 lg:py-24"
    >
      <div className="space-y-3">
        <h2 id={`${id}-title`} className="font-serif text-3xl leading-tight sm:text-4xl">
          {title}
        </h2>
        {lead ? <p className="text-muted">{lead}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function LandingPage() {
  useDocumentTitle("Shade");
  return (
    <PublicPage>
      <section
        aria-labelledby="hero-title"
        className="mx-auto w-full max-w-6xl px-4 pt-12 pb-20 sm:px-6 sm:pt-20 sm:pb-28"
      >
        <div className="relative pl-6 sm:pl-10">
          <span
            aria-hidden
            className="seam absolute top-1 bottom-1 left-0 w-[3px] rounded-[1px] bg-paper"
          />
          <p className="mb-5 max-w-xl font-medium sm:text-lg">
            Private invoices, payment webhooks and agent spending caps on Zcash.
          </p>
          <h1
            id="hero-title"
            className="font-serif text-[2.5rem] leading-[1.04] tracking-tight sm:text-7xl lg:text-8xl"
          >
            {TAGLINE_LINES.map((line, index) => (
              <span key={line} className={index === 1 ? "block text-muted" : "block"}>
                {line}
              </span>
            ))}
          </h1>
          <div className="seam-reveal mt-10 max-w-xl space-y-5">
            <p className="text-xl text-fg">{COPY.siteDefault}</p>
            <p className="text-muted">
              Shade is the vendor layer on Zcash. Create a private invoice, get a webhook when
              shielded ZEC lands, share or revoke a receipt view, and give an AI agent a jar it can
              empty but not overflow.
            </p>
            <HeroActions />
          </div>
        </div>
      </section>

      <Section
        id="objects"
        title="Four objects."
        lead="Zcash already hides sender, receiver and amount. Shade hides the work of using it."
      >
        <dl className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
          {OBJECTS.map((object) => (
            <div key={object.name} className="space-y-3 bg-bg p-6">
              <dt className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-serif text-3xl">{object.name}</span>
                <code className="text-xs text-faint">{object.example}</code>
              </dt>
              <dd className="text-muted">{object.body}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section
        id="loop"
        title="The loop in 90 seconds."
        lead="Real testnet payments, real detection, real signed webhooks."
      >
        <ol className="space-y-0">
          {LOOP.map((step, index) => (
            <li
              key={step.title}
              className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-4 border-b border-line py-5 first:pt-0 sm:grid-cols-[4rem_minmax(0,1fr)]"
            >
              <span className="font-serif text-xl text-faint tabular">{index + 1}.</span>
              <div className="space-y-1">
                <h3 className="font-medium">{step.title}</h3>
                <p className="text-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-8 font-serif text-2xl leading-snug">{COPY.closing}</p>
      </Section>

      <Section id="limits" title="Honest limits." lead="What Shade does not do, said plainly.">
        <ul className="space-y-4">
          {LIMITS.map((limit, index) => (
            <li key={index} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-3">
              <span aria-hidden className="mt-2 h-3 w-px bg-line-strong" />
              <p>{limit}</p>
            </li>
          ))}
        </ul>
      </Section>

      <section
        aria-labelledby="start-title"
        className="mx-auto w-full max-w-6xl border-t border-line px-4 py-16 sm:px-6 lg:py-24"
      >
        <h2 id="start-title" className="font-serif text-4xl sm:text-5xl">
          Start with one invoice.
        </h2>
        <p className="mt-4 max-w-xl text-muted">
          Testnet until you turn on real ZEC. No new coin, no wallet to install for you.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link to="/signup" className={buttonClass("primary")}>
            Create an account
          </Link>
          <Link to="/login" className={buttonClass("ghost")}>
            Sign in
          </Link>
        </div>
      </section>
    </PublicPage>
  );
}
