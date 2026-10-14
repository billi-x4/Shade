import { COPY, jarSummaryCopy } from "@shade/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CornerDownRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { sessionQuery } from "@/api/session";
import { buttonClass } from "@/components/button-styles";
import { BlindGlyph } from "@/components/mark";
import { PublicPage } from "@/components/site-header";
import { StatusText } from "@/components/status-text";
import { cn } from "@/lib/cn";
import { useDocumentTitle } from "@/lib/hooks";
import { grantState, invoiceStatus } from "@/lib/status";

/** COPY.tagline set as three lines: "Pay in the dark." / "Prove in the light." / "Keys stay yours." */
const TAGLINE_LINES = COPY.tagline.split(/(?<=\.)\s+/);

/** COPY.closing as its two sentences. */
const CLOSING_LINES = COPY.closing.split(/(?<=\.)\s+/);

/** Stagger index for the slat-open and rise entrance animations. */
const stagger = (index: number) => ({ "--i": index }) as CSSProperties;

const EYEBROW = "font-mono text-[0.7rem] uppercase tracking-[0.14em] text-faint";

/** Slats of light thrown across the hero, as through a blind. */
const HERO_SLATS = 26;

/* ------------------------------------------------------------------------------------------------
 * Hero
 * ---------------------------------------------------------------------------------------------- */

/**
 * Decorative light behind the hero: a warm pool, and the blind's slats thrown across the wall at an
 * angle. Each slat opens in turn from the window side. With the lit line of the tagline, this is
 * the page's one orchestrated moment; the copy rises after it.
 */
function HeroLight() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-0 bg-[radial-gradient(60%_55%_at_82%_22%,color-mix(in_oklab,var(--color-glow)_11%,transparent),transparent)]" />
      <div className="absolute -top-[18%] -right-[30%] w-[115%] -rotate-[9deg] opacity-[0.17] [mask-image:linear-gradient(258deg,black_8%,rgb(0_0_0/0.5)_40%,transparent_78%)] sm:-right-[22%] sm:w-[95%] lg:-right-[12%] lg:w-[78%]">
        {Array.from({ length: HERO_SLATS }, (_, index) => (
          <span
            key={index}
            className="blinds slat-open block h-[calc(var(--slat)*2.15)] [--slat:0.6rem] sm:[--slat:0.95rem]"
            style={{ "--i": index * 0.4, transformOrigin: "100% 50%" } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

/** Signed-out visitors get the sign-up, like the header; a signed-in merchant goes straight in. */
function HeroActions({ className }: { className?: string }) {
  const session = useQuery(sessionQuery);
  return (
    <div className={cn("rise flex flex-col gap-3 sm:flex-row", className)} style={stagger(7)}>
      {session.data ? (
        <Link to="/desk/invoices" className={buttonClass("primary", "px-5")}>
          Open the desk
          <ArrowRight aria-hidden size={16} strokeWidth={2} />
        </Link>
      ) : (
        <Link to="/signup" className={buttonClass("primary", "px-5")}>
          Create account
          <ArrowRight aria-hidden size={16} strokeWidth={2} />
        </Link>
      )}
      <Link to="/docs" className={buttonClass("ghost", "px-5")}>
        Read the API docs
      </Link>
    </div>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
      <HeroLight />
      <div className="mx-auto w-full max-w-6xl px-4 pt-12 pb-20 sm:px-6 sm:pt-24 sm:pb-28 lg:pt-28 lg:pb-32">
        <h1
          id="hero-title"
          className="font-display text-[length:clamp(2.75rem,14vw,9rem)] leading-[0.9] font-[720] font-stretch-[76%] tracking-[-0.025em]"
        >
          {TAGLINE_LINES.map((line, index) =>
            index === 1 ? (
              // The lit slat: a band of light sweeps in from the left edge and reveals the line,
              // ink on gold. Until the light reaches it, the ink is invisible on night.
              <span key={line} className="relative my-[0.1em] block w-fit py-[0.06em] pr-[0.12em]">
                <span
                  aria-hidden
                  className="slat-open absolute inset-y-0 -right-[0.22em] -left-[100vw] rounded-r-[3px] bg-glow shadow-[0_0_4.5rem_-0.75rem_var(--color-glow)]"
                  style={stagger(2)}
                />
                <span className="relative text-ink">{line} </span>
              </span>
            ) : (
              <span key={line} className="rise block" style={stagger(index === 0 ? 1 : 2)}>
                {line}{" "}
              </span>
            ),
          )}
        </h1>

        <div className="mt-12 grid grid-cols-1 gap-8 sm:mt-16 lg:grid-cols-12 lg:gap-x-8 lg:gap-y-10">
          <p
            className="rise max-w-xl text-xl leading-snug text-fg sm:text-[1.4rem] lg:col-span-7 lg:row-start-1"
            style={stagger(5)}
          >
            Shade gives your shop private Zcash invoices, a signed webhook when each one is paid,
            receipt views you can revoke and spending caps for AI agents.
          </p>
          <p
            className="rise flex max-w-xs items-start gap-3 font-display text-2xl leading-tight text-muted lg:col-span-4 lg:col-start-9 lg:row-span-2 lg:row-start-1 lg:self-end lg:justify-self-end"
            style={stagger(6)}
          >
            <BlindGlyph className="mt-1" />
            {COPY.siteDefault}
          </p>
          <HeroActions className="lg:col-span-7 lg:row-start-2" />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Shared section pieces
 * ---------------------------------------------------------------------------------------------- */

function SectionHead({
  id,
  eyebrow,
  title,
  lead,
  className,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("max-w-2xl space-y-4", className)}>
      <p className={cn(EYEBROW, "flex items-center gap-3")}>
        <span aria-hidden className="slat-rule w-6" />
        {eyebrow}
      </p>
      <h2
        id={`${id}-title`}
        className="font-display text-4xl leading-[0.95] sm:text-5xl lg:text-6xl"
      >
        {title}
      </h2>
      {lead ? <p className="text-lg text-muted">{lead}</p> : null}
    </div>
  );
}

function Section({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="border-t border-line">
      <div
        className={cn("mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:py-32", className)}
      >
        {children}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * The problem: what a public chain shows about a payment, and what Zcash shows
 * ---------------------------------------------------------------------------------------------- */

const LEDGER = [
  { label: "From", value: "0x3f9a…c21e", bar: "w-40" },
  { label: "To", value: "0x7b14…09d2", bar: "w-36" },
  { label: "Amount", value: "0.25", bar: "w-20" },
  { label: "Memo", value: "order_1042", bar: "w-32" },
] as const;

function LedgerCard({ shielded }: { shielded: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-5 sm:p-7",
        shielded ? "border-line-strong bg-surface" : "border-line bg-bg",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-display text-2xl">
          {shielded ? "On Zcash, shielded" : "On a public chain"}
        </h3>
        <p className={EYEBROW}>{shielded ? "Encrypted" : "In the clear"}</p>
      </div>
      <dl className="mt-5 border-t border-line">
        {LEDGER.map((row) => (
          <div
            key={row.label}
            className="grid min-h-14 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-4 border-b border-line"
          >
            <dt className={EYEBROW}>{row.label}</dt>
            <dd className="min-w-0">
              {shielded ? (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      "blinds block h-6 max-w-full rounded-[2px] opacity-80 [--slat:0.11rem]",
                      row.bar,
                    )}
                  />
                  <span className="sr-only">Hidden</span>
                </>
              ) : row.label === "Amount" ? (
                <span className="font-display text-3xl leading-none tabular">{row.value}</span>
              ) : (
                <span className="font-mono text-sm wrap-anywhere text-fg">{row.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-5 text-muted">
        {shielded
          ? "An explorer sees a shielded transaction, its block and its fee. The sender, the receiver, the amount and the memo stay encrypted."
          : "Anyone can read this line and follow both addresses to their other payments."}
      </p>
    </div>
  );
}

function ProblemSection() {
  return (
    <Section id="problem">
      <SectionHead
        id="problem"
        eyebrow="The problem"
        title="A public chain shows everyone your sales."
        lead="Anyone with a block explorer can read who paid you, how much and what for. Zcash can encrypt all of it. Here is the same payment both ways."
      />
      <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 lg:mt-16">
        <LedgerCard shielded={false} />
        <LedgerCard shielded />
      </div>
      <p className="mt-8 max-w-2xl text-muted">
        Shade refuses transparent addresses, so every invoice is paid into Zcash's shielded pool.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * How it works: the loop
 * ---------------------------------------------------------------------------------------------- */

interface LoopStep {
  title: string;
  body: string;
  /** The step where something becomes true: lit. */
  lit?: boolean;
  /** What the step produces, drawn small beside it. Decorative. */
  output: { label: string; content: ReactNode };
}

const LOOP: LoopStep[] = [
  {
    title: "Invoice",
    body: "Create a 0.01 ZEC invoice on the desk or with one API call. Shade returns a pay page and a ZIP-321 payment link.",
    output: {
      label: "Pay link",
      content: <span className="font-mono text-xs">zcash:utest1…?amount=0.01</span>,
    },
  },
  {
    title: "Pay",
    body: "The payer scans the QR code and pays from their own shielded wallet. An explorer sees the transaction, but not who paid or how much.",
    output: {
      label: "Explorer",
      content: (
        <span className="flex items-center gap-3 font-mono text-xs">
          Amount
          <span className="blinds block h-4 w-20 rounded-[1px] opacity-80 [--slat:0.1rem]" />
        </span>
      ),
    },
  },
  {
    title: "Paid",
    body: "Shade finds the payment with your viewing key, or you record it from your wallet. The invoice turns Paid and your server gets a signed invoice.paid webhook.",
    lit: true,
    output: {
      label: "Webhook",
      content: (
        <span className="flex items-center gap-2 font-mono text-xs text-fg">
          <span className="h-2.5 w-1 rounded-[1px] bg-ok" />
          invoice.paid · 200
        </span>
      ),
    },
  },
  {
    title: "Grant",
    body: "Open a 10-minute grant. Your accountant sees the receipt and downloads the CSV. Revoke it and both go dark.",
    output: {
      label: "View link",
      content: <span className="font-mono text-xs">/view#gv_… · 10 min</span>,
    },
  },
  {
    title: "Jar",
    body: "Give an agent a jar capped at 0.006 ZEC. It pays 0.002 three times. Shade refuses the fourth call. The jar is empty.",
    output: { label: "Agent", content: <span className="text-sm">{COPY.jarEmpty}</span> },
  },
];

function LoopSection() {
  return (
    <Section id="loop">
      <SectionHead
        id="loop"
        eyebrow="How it works"
        title="The loop in 90 seconds."
        lead="Every step runs on Zcash testnet with a real shielded payment."
      />
      <ol className="mt-12 border-t border-line lg:mt-16">
        {LOOP.map((step, index) => (
          <li
            key={step.title}
            className={cn(
              "relative grid grid-cols-[3rem_minmax(0,1fr)] gap-x-4 border-b border-line py-7 pl-4 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-x-6 sm:pl-6 lg:grid-cols-[5rem_minmax(0,1fr)_17rem] lg:items-center lg:gap-x-10 lg:py-9",
              step.lit &&
                "bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-glow)_7%,transparent),transparent_70%)]",
            )}
          >
            <span
              className={cn(
                "font-display text-4xl leading-none tabular sm:text-6xl lg:self-start",
                step.lit ? "text-glow" : "text-faint",
              )}
            >
              {index + 1}.
            </span>
            {step.lit ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-1 bg-glow shadow-[0_0_1.25rem_var(--color-glow)]"
              />
            ) : null}
            <div className="min-w-0 space-y-2">
              <h3 className="font-display text-2xl leading-tight sm:text-3xl">{step.title}</h3>
              <p className="max-w-xl text-muted">{step.body}</p>
            </div>
            <div
              aria-hidden
              className={cn(
                "col-start-2 mt-5 min-w-0 space-y-2 rounded-sm border px-4 py-3 text-muted lg:col-start-3 lg:mt-0",
                step.lit ? "border-glow/60 bg-bg" : "border-line bg-bg/60",
              )}
            >
              <p className={EYEBROW}>{step.output.label}</p>
              <div className="truncate">{step.output.content}</div>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * The four objects, each with a small decorative mock
 * ---------------------------------------------------------------------------------------------- */

const MOCK = "rounded-md border border-line bg-bg p-4 sm:p-5";

function InvoiceMock() {
  return (
    <div className={MOCK}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="font-mono text-xs text-faint">memo order_1042</span>
        <StatusText
          status={invoiceStatus({ status: "paid", verification: "ivk_scan", detection: null })}
        />
      </div>
      <p className="mt-5 font-display text-6xl leading-none tabular sm:text-7xl">
        0.01<span className="ml-2 text-2xl text-muted sm:text-3xl">ZEC</span>
      </p>
      <p className="mt-5 truncate font-mono text-xs text-faint">
        zcash:utest1qx9…k7m2?amount=0.01&memo=b3JkZXJfMTA0Mg
      </p>
    </div>
  );
}

/** Six slats for a 0.006 ZEC cap. The lit ones are what the agent can still spend. */
function JarMock() {
  return (
    <div className={MOCK}>
      <div className="flex items-center justify-between gap-4 font-mono text-xs text-faint">
        <span>research-agent</span>
        <span>2 charges</span>
      </div>
      <div className="mt-5 grid gap-[6px]">
        {Array.from({ length: 6 }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-2.5 rounded-[1px]",
              index >= 4 ? "bg-glow shadow-[0_0_1rem_-0.25rem_var(--color-glow)]" : "bg-line",
            )}
          />
        ))}
      </div>
      <p className="mt-5 text-sm text-muted tabular">{jarSummaryCopy("0.006", "0.004", "0.002")}</p>
    </div>
  );
}

/** The auditor's side is paper: a pass that runs out. */
function GrantMock() {
  return (
    <div className="theme-paper rounded-md p-4 shadow-[0_1.5rem_3rem_-1.75rem_var(--color-ink)] sm:p-5">
      <div className="flex items-center justify-between gap-4">
        <span className="font-mono text-xs text-faint">payroll · receipts</span>
        <StatusText status={grantState("active")} />
      </div>
      <p className="mt-5 flex items-baseline gap-3 font-display leading-none">
        <span className="text-6xl tabular sm:text-7xl">09:41</span>
        <span className="text-xl text-muted">left</span>
      </p>
      <div className="mt-5 h-1.5 overflow-hidden rounded-[1px] bg-surface-2">
        <div className="h-full w-[64%] bg-fg" />
      </div>
    </div>
  );
}

function TagMock() {
  return (
    <div className={MOCK}>
      <p className="font-mono text-xs text-faint">GET /v1/tags/northline</p>
      <p className="mt-4 font-display text-4xl leading-none sm:text-5xl">
        northline<span className="text-glow">.shade</span>
      </p>
      <p className="mt-4 flex min-w-0 items-center gap-2 font-mono text-xs text-muted">
        <CornerDownRight size={14} strokeWidth={1.75} className="shrink-0 text-glow" />
        <span className="truncate">utest1qx9mu4…k7m2wdcfz</span>
      </p>
    </div>
  );
}

const OBJECTS = [
  {
    name: "Invoice",
    body: "Asks for an exact amount of ZEC with a memo. The payer gets a pay page, a QR code and a link their wallet opens.",
    mock: <InvoiceMock />,
    span: "md:col-span-7",
  },
  {
    name: "Jar",
    body: "A spending limit for an AI agent. Charges stop at the cap, and you can kill the jar at any time.",
    mock: <JarMock />,
    span: "md:col-span-5",
  },
  {
    name: "Grant",
    body: "A receipt view for your accountant, open from 10 minutes up to 90 days. Revoke it and the view goes dark.",
    mock: <GrantMock />,
    span: "md:col-span-5",
  },
  {
    name: "Tag",
    body: "A short name like northline.shade that points at your Unified Address. Apps and agents look it up to find where to pay you.",
    mock: <TagMock />,
    span: "md:col-span-7",
  },
] as const;

function ObjectsSection() {
  return (
    <Section id="objects">
      <SectionHead
        id="objects"
        eyebrow="The objects"
        title="Four objects."
        lead="Zcash already hides who paid and how much. Shade adds the four things a shop needs on top."
      />
      <ul className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-12 md:gap-5 lg:mt-16">
        {OBJECTS.map((object) => (
          <li
            key={object.name}
            className={cn(
              "flex min-w-0 flex-col gap-8 rounded-lg border border-line bg-surface p-5 sm:p-7",
              object.span,
            )}
          >
            <div className="space-y-3">
              <h3 className="font-display text-4xl leading-none sm:text-5xl">{object.name}</h3>
              <p className="max-w-md text-muted">{object.body}</p>
            </div>
            <div aria-hidden className="mt-auto">
              {object.mock}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * For developers
 * ---------------------------------------------------------------------------------------------- */

const SDK_SAMPLE = `import { Shade } from "shade-zcash-sdk";
const shade = new Shade({ apiKey: process.env.SHADE_API_KEY! });
const invoice = await shade.invoices.create({ amountZec: "0.01", memo: "order_1042" });
// Send the payer to invoice.payUrl`;

/** Strings, comments and keywords of the sample, so they can take the page's tokens. */
const TOKEN = /("[^"]*")|(\/\/.*$)|\b(import|from|const|new|await)\b/g;

function highlight(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    const [text, string, comment] = match;
    if (match.index > last) parts.push(line.slice(last, match.index));
    const tone = string ? "text-glow" : comment ? "text-faint" : "text-muted";
    parts.push(
      <span key={match.index} className={tone}>
        {text}
      </span>,
    );
    last = match.index + text.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

function DevelopersSection() {
  return (
    <Section id="developers">
      <SectionHead
        id="developers"
        eyebrow="For developers"
        title="Your first invoice in four lines."
        lead="The TypeScript SDK wraps the /v1 API. It has no dependencies and runs on Node 20 or later."
      />
      <div className="mt-12 grid grid-cols-1 gap-10 lg:mt-16 lg:grid-cols-12">
        <div className="min-w-0 space-y-6 lg:col-span-4">
          <p className="flex items-baseline gap-3 rounded-sm border border-line-strong bg-surface px-4 py-3 font-mono text-sm">
            <span aria-hidden className="text-glow">
              $
            </span>
            <code className="wrap-anywhere text-fg">npm install shade-zcash-sdk</code>
          </p>
          <p className="text-muted">
            Every webhook arrives signed. <code className="text-fg">verifyWebhook</code> checks the
            signature and its timestamp before you ship the order.
          </p>
          <Link to="/docs" className={buttonClass("ghost", "px-5")}>
            Read the API docs
            <ArrowRight aria-hidden size={16} strokeWidth={2} />
          </Link>
        </div>
        <div className="min-w-0 lg:col-span-8">
          <div className="overflow-hidden rounded-lg border border-line-strong bg-surface">
            <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
              <BlindGlyph />
              <span className="font-mono text-xs text-faint">checkout.ts</span>
            </div>
            <pre
              aria-label="SDK example"
              tabIndex={0}
              className="overflow-x-auto py-5 text-fg focus-visible:-outline-offset-2"
            >
              {/* Narrow screens wrap long lines under their number; wide ones keep one line each. */}
              <code className="grid gap-y-1.5 text-xs leading-[1.75] font-light font-stretch-75% xl:min-w-max xl:gap-y-0 xl:leading-[2.1]">
                {SDK_SAMPLE.split("\n").map((line, index) => (
                  <span
                    key={index}
                    className="grid grid-cols-[2.5rem_minmax(0,1fr)] pr-5 xl:grid-cols-[2.5rem_auto]"
                  >
                    <span aria-hidden className="pr-4 text-right text-faint select-none">
                      {index + 1}
                    </span>
                    <span className="whitespace-pre-wrap wrap-anywhere xl:whitespace-pre">
                      {highlight(line)}
                    </span>
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Honest limits: set on paper, the proof side
 * ---------------------------------------------------------------------------------------------- */

const LIMITS: { topic: string; text: ReactNode }[] = [
  {
    topic: "Keys",
    text: "Shade is not a wallet. It never holds a seed or a spending key. It refuses transparent addresses.",
  },
  { topic: "Jars", text: COPY.jarIsLimit },
  { topic: "Killing a jar", text: COPY.killNote },
  { topic: "Grants", text: COPY.grantNote },
  { topic: "Timing", text: COPY.lag },
  {
    topic: "Detection",
    text: "Automatic detection needs a full viewing key. That key also shows your outgoing payments. Use a receive-only account, or run the scanner on your own machine.",
  },
  { topic: "Light server", text: COPY.chainPrivacyNote },
  {
    topic: "Linking",
    text: "A payment that moves between Zcash pools shows the amount that crosses. One shop address links that shop's pay pages for anyone who compares them.",
  },
  { topic: "Upgrades", text: COPY.quantum },
];

function LimitsSection() {
  return (
    <section
      id="limits"
      aria-labelledby="limits-title"
      className="border-t border-line px-4 py-20 sm:px-6 sm:py-28 lg:py-32"
    >
      <div className="theme-paper relative mx-auto w-full max-w-6xl overflow-hidden rounded-lg px-5 py-12 sm:px-10 sm:py-16 lg:px-14">
        <span
          aria-hidden
          className="blinds pointer-events-none absolute -top-10 -right-24 h-72 w-[34rem] -rotate-6 opacity-[0.16] [--slat:0.8rem] [mask-image:linear-gradient(225deg,black,transparent_70%)]"
        />
        <SectionHead
          id="limits"
          eyebrow="Read this first"
          title="Honest limits."
          lead="What Shade cannot do, and what other people can still see."
          className="relative"
        />
        <dl className="relative mt-12 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2 lg:mt-14 lg:grid-cols-3">
          {LIMITS.map((limit) => (
            <div key={limit.topic} className="space-y-2 border-t border-line-strong pt-4">
              <dt className={EYEBROW}>{limit.topic}</dt>
              <dd>{limit.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Closing call to action
 * ---------------------------------------------------------------------------------------------- */

function ClosingSection() {
  return (
    <section aria-labelledby="start-title" className="relative isolate overflow-hidden">
      <span
        aria-hidden
        className="blinds blinds-fade pointer-events-none absolute -bottom-24 -left-24 -z-10 h-[30rem] w-[60rem] max-w-[150%] rotate-[8deg] opacity-[0.1] [--slat:1.1rem]"
      />
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-6 sm:pb-32 lg:pb-40">
        <p className={cn(EYEBROW, "flex items-center gap-3")}>
          <span aria-hidden className="slat-rule w-6" />
          Start with one invoice
        </p>
        <h2
          id="start-title"
          className="mt-6 max-w-5xl font-display text-[length:clamp(2.4rem,6.4vw,5.25rem)] leading-[0.95]"
        >
          {CLOSING_LINES.map((line, index) => (
            <span key={line} className={cn("block", index > 0 && "text-muted")}>
              {line}{" "}
            </span>
          ))}
        </h2>
        <p className="mt-8 max-w-xl text-lg text-muted">
          Shade starts on testnet, where the coins have no value. Your payers use the shielded
          wallet they already have.
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link to="/signup" className={buttonClass("primary", "px-5")}>
            Create an account
          </Link>
          <Link to="/login" className={buttonClass("ghost", "px-5")}>
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}

export function LandingPage() {
  useDocumentTitle("Shade");
  return (
    <PublicPage>
      <Hero />
      <ProblemSection />
      <LoopSection />
      <ObjectsSection />
      <DevelopersSection />
      <LimitsSection />
      <ClosingSection />
    </PublicPage>
  );
}
