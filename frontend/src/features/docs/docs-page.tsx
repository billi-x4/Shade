import { COPY, ERROR_CODES } from "@shade/contract";
import type { ReactNode } from "react";
import { PublicPage } from "@/components/site-header";
import {
  CURL_INVOICE,
  ENDPOINTS,
  ERROR_BODY,
  ERROR_STATUS,
  GRANT_EXAMPLE,
  INVOICE_RESPONSE,
  JAR_EXAMPLE,
  SDK_EXAMPLE,
  WEBHOOK_BODY,
  WEBHOOK_VERIFY,
  WEBHOOK_VERIFY_GO,
  WEBHOOK_VERIFY_PYTHON,
  WEBHOOK_VERIFY_SDK,
} from "@/features/docs/docs-content";
import { useDocumentTitle } from "@/lib/hooks";

const SECTIONS = [
  { id: "start", label: "Start" },
  { id: "endpoints", label: "Endpoints" },
  { id: "invoices", label: "Invoices" },
  { id: "jars", label: "Jars" },
  { id: "grants", label: "Grants" },
  { id: "webhooks", label: "Webhooks" },
  { id: "errors", label: "Errors" },
  { id: "limits", label: "Honest limits" },
] as const;

function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-sm border border-line-strong bg-surface p-4 text-[0.8125rem] leading-relaxed text-fg"
    >
      <code>{children}</code>
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-6 space-y-4 border-t border-line pt-10"
    >
      <h2 id={`${id}-title`} className="font-serif text-3xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

const C = ({ children }: { children: ReactNode }) => <code className="text-fg">{children}</code>;

export function DocsPage() {
  useDocumentTitle("API docs");
  const origin =
    typeof window === "undefined" ? "https://shade-zcash.vercel.app" : window.location.origin;
  const base = `${origin}/v1`;
  return (
    <PublicPage className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
      <div className="grid gap-10 pt-8 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-16 lg:pt-16">
        <nav aria-label="On this page" className="lg:sticky lg:top-6 lg:self-start">
          <ul className="flex flex-wrap gap-x-3 lg:flex-col">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <article className="min-w-0 max-w-3xl space-y-10">
          <header className="space-y-4">
            <h1 className="font-serif text-4xl leading-tight sm:text-5xl">
              Call Shade. Skip the cryptography.
            </h1>
            <p className="text-lg text-muted">
              Five calls cover the product: invoices, jars, grants, webhooks and tags. JSON in, JSON
              out, amounts as decimal ZEC strings.
            </p>
          </header>

          <Section id="start" title="Start">
            <ul className="space-y-2 text-muted">
              <li>
                Base URL <C>{base}</C>. Send <C>Authorization: Bearer sk_test_…</C> (testnet) or{" "}
                <C>sk_live_…</C> (mainnet). Create keys in the desk under Settings → API keys.
              </li>
              <li>
                Each key belongs to one network. Resources on the other network answer 404, and a
                key for a network this server has turned off gets <C>403 NETWORK_DISABLED</C>.
              </li>
              <li>
                Agent keys (<C>ag_…</C>) come from a jar and may only charge it (
                <C>POST /v1/jars/&lt;their jar&gt;/charge</C>) and read its budget (
                <C>GET /v1/jars/&lt;their jar&gt;</C>).
              </li>
              <li>
                Testnet with an <C>sk_test_…</C> key is test mode: real testnet payments, no fake
                ones. To test a receiver, press Send test under Webhooks (<C>webhook.test</C>) or
                sign your own fixture with the SDK's <C>signWebhook</C>.
              </li>
              <li>
                <C>POST /v1/invoices</C>, <C>/v1/jars</C> and <C>/v1/jars/:id/charge</C> accept an{" "}
                <C>Idempotency-Key</C> header: the same key and body replays the first answer; a
                different body gets <C>422 IDEMPOTENCY_MISMATCH</C>. Keys are kept for 24 hours.
              </li>
              <li>
                Lists take <C>?cursor=&amp;limit=</C> (default 25, max 100), newest first, and
                return <C>{"{ items, next_cursor }"}</C>. Each key may make 600 requests a minute;
                requests with a missing or wrong key are limited to 60 a minute per IP.
              </li>
            </ul>
            <p className="text-muted">
              With the TypeScript SDK (camelCase in, camelCase out). It lives in this repository
              under <C>backend/sdk</C>: build it with <C>npm run build -w @shade/sdk</C>, or{" "}
              <C>npm pack</C> it into your project.
            </p>
            <Code label="SDK example">{SDK_EXAMPLE(origin)}</Code>
          </Section>

          <Section id="endpoints" title="Endpoints">
            <div
              className="overflow-x-auto rounded-sm border border-line"
              tabIndex={0}
              aria-label="Endpoint table"
            >
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead className="bg-surface text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Route
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Auth
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Body
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Success
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Errors
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line align-top">
                  {ENDPOINTS.map((endpoint) => (
                    <tr key={`${endpoint.method} ${endpoint.path}`}>
                      <th
                        scope="row"
                        className="px-3 py-2 font-mono font-normal whitespace-nowrap text-fg"
                      >
                        {endpoint.method} {endpoint.path}
                      </th>
                      <td className="px-3 py-2 text-muted">{endpoint.auth}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted">{endpoint.body}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{endpoint.success}</td>
                      <td className="px-3 py-2 text-xs text-muted">{endpoint.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="invoices" title="Invoices">
            <p className="text-muted">
              An invoice asks for an exact amount of ZEC. Shade answers with a pay page, a ZIP-321
              link (<C>zcash:…?amount=…&amp;memo=…</C>) and the receive address. The memo may be up
              to 495 bytes; Shade appends a short reference, <C>(shade:7K2Q9MXA)</C>, so every
              invoice has a unique on-chain memo.
              <C>tag</C> is a free label (like <C>payroll</C>) that grants can be scoped to.
            </p>
            <Code label="Create an invoice with curl">{CURL_INVOICE(base)}</Code>
            <Code label="Invoice response">{INVOICE_RESPONSE}</Code>
            <p className="text-muted">
              Status moves <C>open</C> → <C>paid</C>. A txid pasted by the payer only makes it{" "}
              <C>paid_unverified</C> (no webhook); it becomes <C>paid</C> when a viewing-key scan
              finds the payment (<C>verification: "ivk_scan"</C>) or you confirm it on the desk (
              <C>"merchant_accept"</C>). Running your own scanner? Report a match with{" "}
              <C>POST /v1/invoices/:id/detections</C> and Shade checks it against the chain before
              settling.
            </p>
          </Section>

          <Section id="jars" title="Jars">
            <p className="text-muted">
              {COPY.jarIsLimit} A charge counts against the cap; past it the agent gets a 402.
            </p>
            <Code label="Jar example">{JAR_EXAMPLE}</Code>
            <p className="text-muted">
              Kill stops new charges: they answer <C>409 JAR_CLOSED</C>. {COPY.killNote}
            </p>
          </Section>

          <Section id="grants" title="Grants">
            <p className="text-muted">
              A grant is a time-boxed, read-only receipt view: <C>scope</C> is <C>all</C> or an
              invoice label, for <C>days</C> (1–90) or <C>expires_in_sec</C> (10 minutes to 90
              days). The view link is returned once and carries the token after <C>#</C>, so it
              never reaches a server log.
            </p>
            <Code label="Grant example">{GRANT_EXAMPLE}</Code>
            <p className="text-muted">{COPY.grantNote}</p>
          </Section>

          <Section id="webhooks" title="Webhooks">
            <p className="text-muted">
              Register an https endpoint; the signing secret (<C>whsec_…</C>) is shown once. Shade
              creates one <C>invoice.paid</C> event per invoice (and <C>webhook.test</C> on demand)
              and delivers it at least once. The body never carries the payer's address or the memo
              text, only its hash.
            </p>
            <Code label="Webhook body">{WEBHOOK_BODY}</Code>
            <ul className="space-y-2 text-muted">
              <li>
                <C>X-Shade-Signature-V2: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</C> — HMAC-SHA256 of{" "}
                <C>t + "." + raw body</C> with your secret, signed fresh for every attempt. Reject
                it when <C>|now − t| &gt; 300</C>.
              </li>
              <li>
                <C>X-Shade-Signature: sha256=&lt;hex&gt;</C> — HMAC-SHA256 of the raw body alone
                (PRD shape). It never expires, and Shade always sends V2 as well, so verify V2: a
                delivery without it may be a replay with the header stripped. The SDK refuses one
                unless you pass <C>allowLegacySignature</C>.
              </li>
              <li>
                <C>X-Shade-Event-Id</C> equals the body's <C>id</C>. Deliveries can repeat: dedupe
                by it.
              </li>
              <li>
                Answer 2xx within 10 seconds. Anything else is retried with backoff for about three
                days; 410 Gone turns the endpoint off. Redirects are not followed.
              </li>
            </ul>
            <Code label="Verify with the SDK">{WEBHOOK_VERIFY_SDK}</Code>
            <Code label="Verify with Node.js only">{WEBHOOK_VERIFY}</Code>
            <Code label="Verify with Python">{WEBHOOK_VERIFY_PYTHON}</Code>
            <Code label="Verify with Go">{WEBHOOK_VERIFY_GO}</Code>
          </Section>

          <Section id="errors" title="Errors">
            <p className="text-muted">
              Every error is an HTTP status plus a JSON body. <C>error</C> is stable; <C>message</C>{" "}
              is a plain sentence you can show. Validation errors add <C>issues</C> (field paths,
              never your values); rate limits and chain outages add <C>retry_after</C>.
            </p>
            <Code label="Error body">{ERROR_BODY}</Code>
            <div
              className="overflow-x-auto rounded-sm border border-line"
              tabIndex={0}
              aria-label="Error codes"
            >
              <table className="w-full text-left text-sm">
                <thead className="bg-surface text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Code
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {ERROR_CODES.map((code) => (
                    <tr key={code}>
                      <th scope="row" className="px-3 py-1.5 font-mono font-normal text-fg">
                        {code}
                      </th>
                      <td className="px-3 py-1.5 text-muted tabular">{ERROR_STATUS[code]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="limits" title="Honest limits">
            <ul className="space-y-2 text-muted">
              <li>
                Shade is not a wallet: no seeds, no spending keys. Payments go straight to your
                Unified Address.
              </li>
              <li>{COPY.lag}</li>
              <li>{COPY.chainPrivacyNote}</li>
              <li>{COPY.quantum}</li>
              <li>Transparent addresses are refused. ZEC only. Testnet is the default.</li>
            </ul>
          </Section>
        </article>
      </div>
    </PublicPage>
  );
}
