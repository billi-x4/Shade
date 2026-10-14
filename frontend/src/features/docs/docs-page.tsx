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
  type Endpoint,
} from "@/features/docs/docs-content";
import { cn } from "@/lib/cn";
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

type SectionId = (typeof SECTIONS)[number]["id"];

const EYEBROW = "font-mono text-[0.7rem] uppercase tracking-[0.14em] text-faint";

/** Reading width for prose; code and tables use the whole column. */
const PROSE = "max-w-[68ch] text-muted";

/** Endpoints grouped by resource (/v1/<resource>/…), in table order. */
const ENDPOINT_GROUPS = ENDPOINTS.reduce<{ name: string; endpoints: Endpoint[] }[]>(
  (groups, endpoint) => {
    const resource = endpoint.path.split("/")[2] ?? "";
    const name = resource.charAt(0).toUpperCase() + resource.slice(1);
    const group = groups.find((candidate) => candidate.name === name);
    if (group) group.endpoints.push(endpoint);
    else groups.push({ name, endpoints: [endpoint] });
    return groups;
  },
  [],
);

/** Error codes grouped by HTTP status, lowest status first. */
const ERROR_GROUPS = [...new Set(ERROR_CODES.map((code) => ERROR_STATUS[code]))]
  .sort((a, b) => a - b)
  .map((status) => ({
    status,
    codes: ERROR_CODES.filter((code) => ERROR_STATUS[code] === status),
  }));

/** Inline code. */
const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[3px] bg-surface-2 px-1 py-px text-[0.84em] font-light wrap-anywhere text-fg [box-decoration-break:clone]">
    {children}
  </code>
);

/** Full-line comments (// or #) render quieter than the code around them. */
function renderSource(source: string): ReactNode[] {
  const lines = source.split("\n");
  return lines.flatMap((line, index) => {
    const node = /^\s*(\/\/|#)/.test(line) ? (
      <span key={index} className="text-faint">
        {line}
      </span>
    ) : (
      line
    );
    return index < lines.length - 1 ? [node, "\n"] : [node];
  });
}

function Code({ children, label }: { children: string; label: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-line-strong bg-surface">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span aria-hidden className="slat-rule w-4" />
        <p className={EYEBROW}>{label}</p>
      </div>
      <pre
        aria-label={label}
        tabIndex={0}
        className="max-w-full overflow-x-auto p-4 leading-relaxed text-fg [tab-size:2] focus-visible:-outline-offset-2 sm:px-5"
      >
        <code className="text-[0.8125rem] font-light">{renderSource(children)}</code>
      </pre>
    </div>
  );
}

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  const number = SECTIONS.findIndex((section) => section.id === id) + 1;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-32 border-t border-line pt-10 first:border-t-0 first:pt-0 sm:scroll-mt-24 sm:pt-12 sm:first:pt-0"
    >
      <p aria-hidden className="font-mono text-[0.7rem] text-faint tabular">
        {String(number).padStart(2, "0")}
      </p>
      <h2 id={`${id}-title`} className="mt-2 font-display text-3xl leading-tight sm:text-4xl">
        {title}
      </h2>
      <div className="mt-6 space-y-5">{children}</div>
    </section>
  );
}

/** A plain list with slat bullets. */
function Rules({ children }: { children: ReactNode[] }) {
  return (
    <ul className="max-w-[68ch] space-y-3 text-muted">
      {children.map((child, index) => (
        <li key={index} className="grid grid-cols-[0.875rem_minmax(0,1fr)] gap-3">
          <span aria-hidden className="mt-[0.7em] h-[3px] w-2.5 rounded-[1px] bg-line-strong" />
          <span>{child}</span>
        </li>
      ))}
    </ul>
  );
}

const METHOD_TONE: Record<Endpoint["method"], string> = {
  GET: "bg-ok/10 text-ok",
  POST: "bg-glow/10 text-glow",
  DELETE: "bg-bad/10 text-bad",
};

/** HTTP method as a chip. The word carries the meaning; the color only echoes it. */
function Method({ method }: { method: Endpoint["method"] }) {
  return (
    <span
      className={cn(
        "inline-flex w-14 shrink-0 justify-center rounded-[3px] py-0.5 font-mono text-[0.65rem] font-medium tracking-wider",
        METHOD_TONE[method],
      )}
    >
      {method}
    </span>
  );
}

function EndpointTable() {
  return (
    <>
      <div
        className="hidden overflow-x-auto rounded-md border border-line-strong xl:block"
        tabIndex={0}
        aria-label="Endpoint table"
      >
        <table className="w-full min-w-[54rem] table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[18rem]" />
            <col className="w-16" />
            <col className="w-[11.5rem]" />
            <col className="w-[10.5rem]" />
            <col />
          </colgroup>
          <thead className="border-b border-line-strong bg-surface">
            <tr>
              {["Route", "Auth", "Body", "Success", "Errors"].map((heading) => (
                <th key={heading} scope="col" className={cn(EYEBROW, "px-3 py-3 font-normal")}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          {ENDPOINT_GROUPS.map((group) => (
            <tbody key={group.name} className="border-b border-line last:border-b-0">
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={5}
                  className="px-3 pt-5 pb-1 text-left font-display text-xl text-fg"
                >
                  {group.name}
                </th>
              </tr>
              {group.endpoints.map((endpoint) => (
                <tr key={`${endpoint.method} ${endpoint.path}`} className="align-top">
                  <th scope="row" className="px-3 py-3 text-left font-normal">
                    <span className="flex items-center gap-2.5 whitespace-nowrap">
                      <Method method={endpoint.method} />
                      <code className="text-xs font-light font-stretch-75% text-fg">
                        {endpoint.path}
                      </code>
                    </span>
                  </th>
                  <td className="px-3 py-3 text-muted">{endpoint.auth}</td>
                  <td className="px-3 py-3">
                    <code className="text-xs font-light font-stretch-75% wrap-anywhere text-muted">
                      {endpoint.body}
                    </code>
                  </td>
                  <td className="px-3 py-3 text-[0.8125rem] break-words text-fg">
                    {endpoint.success}
                  </td>
                  <td className="px-3 py-3 text-xs break-words text-muted">{endpoint.errors}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      {/* Below xl: the same endpoints as cards, one route each. */}
      <div className="space-y-6 xl:hidden">
        {ENDPOINT_GROUPS.map((group) => (
          <div key={group.name} className="space-y-3">
            <p className="font-display text-xl text-fg">{group.name}</p>
            <ul className="space-y-3">
              {group.endpoints.map((endpoint) => (
                <li
                  key={`${endpoint.method} ${endpoint.path}`}
                  className="rounded-md border border-line-strong bg-surface p-4"
                >
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Method method={endpoint.method} />
                    <code className="text-[0.8rem] font-light wrap-anywhere text-fg">
                      {endpoint.path}
                    </code>
                  </p>
                  <dl className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm md:grid-cols-[4.5rem_minmax(0,1fr)_4.5rem_minmax(0,1.6fr)]">
                    <dt className={cn(EYEBROW, "pt-0.5")}>Auth</dt>
                    <dd className="text-muted">{endpoint.auth}</dd>
                    <dt className={cn(EYEBROW, "pt-0.5")}>Success</dt>
                    <dd className="text-fg">{endpoint.success}</dd>
                    <dt className={cn(EYEBROW, "pt-0.5")}>Body</dt>
                    <dd className="font-mono text-xs font-light wrap-anywhere text-muted md:col-span-3">
                      {endpoint.body}
                    </dd>
                    <dt className={cn(EYEBROW, "pt-0.5")}>Errors</dt>
                    <dd className="text-xs wrap-anywhere text-muted md:col-span-3">
                      {endpoint.errors}
                    </dd>
                  </dl>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

const HEADERS: { name: string; value?: string; body: ReactNode }[] = [
  {
    name: "X-Shade-Signature-V2",
    value: "t=<unix seconds>,v1=<hex>",
    body: (
      <>
        HMAC-SHA256 of <C>t + "." + raw body</C> with your secret. Shade signs every attempt again.
        Reject a delivery when <C>|now − t| &gt; 300</C>.
      </>
    ),
  },
  {
    name: "X-Shade-Signature",
    value: "sha256=<hex>",
    body: (
      <>
        HMAC-SHA256 of the raw body alone, the original format. It never expires. Shade always sends
        V2 as well, so verify V2. A delivery without V2 may be a replay with that header stripped.
        The SDK refuses one unless you pass <C>allowLegacySignature</C>.
      </>
    ),
  },
  {
    name: "X-Shade-Event-Id",
    body: (
      <>
        Equals the body's <C>id</C>. Deliveries can repeat, so dedupe by it.
      </>
    ),
  },
];

export function DocsPage() {
  useDocumentTitle("API docs");
  const origin =
    typeof window === "undefined" ? "https://shade-zcash.vercel.app" : window.location.origin;
  const base = `${origin}/v1`;
  return (
    <PublicPage>
      <div className="relative isolate overflow-hidden border-b border-line">
        <span
          aria-hidden
          className="blinds blinds-fade pointer-events-none absolute -top-16 -right-40 -z-10 h-[26rem] w-[44rem] -scale-x-100 -rotate-6 opacity-[0.08] [--slat:0.85rem]"
        />
        <header className="mx-auto grid w-full max-w-6xl gap-10 px-4 pt-12 pb-14 sm:px-6 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-end lg:gap-16 lg:pt-20">
          <div className="max-w-2xl space-y-4">
            <span aria-hidden className="slat-open block h-1 w-12 rounded-[1px] bg-glow" />
            <h1 className="font-display text-5xl leading-[0.95] sm:text-6xl">
              <span className="block">Call Shade. </span>
              <span className="block">Skip the cryptography.</span>
            </h1>
            <p className="text-lg text-muted">
              Five resources cover the product: invoices, jars, grants, webhooks and tags. Requests
              and responses are JSON. Amounts are decimal ZEC strings, like <C>"0.01"</C>.
            </p>
          </div>
          <dl className="divide-y divide-line rounded-lg border border-line-strong bg-surface text-sm">
            <div className="space-y-1.5 p-4">
              <dt className={EYEBROW}>Base URL</dt>
              <dd className="font-mono text-[0.8rem] font-light wrap-anywhere text-fg">{base}</dd>
            </div>
            <div className="space-y-1.5 p-4">
              <dt className={EYEBROW}>Auth header</dt>
              <dd className="font-mono text-[0.8rem] font-light wrap-anywhere text-fg">
                Authorization: Bearer sk_test_…
              </dd>
              <dd className="text-muted">
                Use <C>sk_test_…</C> on testnet and <C>sk_live_…</C> on mainnet. Create keys in the
                desk under Settings → API keys.
              </dd>
            </div>
            <div className="space-y-1.5 p-4">
              <dt className={EYEBROW}>SDK</dt>
              <dd className="font-mono text-[0.8rem] font-light text-fg">
                npm install shade-zcash-sdk
              </dd>
            </div>
          </dl>
        </header>
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 pt-8 pb-24 sm:px-6 lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-12 lg:pt-14">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <p className={cn(EYEBROW, "mb-3 hidden lg:block")}>On this page</p>
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-0 lg:border-l lg:border-line">
            {SECTIONS.map((section, index) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="inline-flex min-h-11 items-center gap-3 rounded-sm border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-fg lg:-ml-px lg:w-full lg:rounded-none lg:border-0 lg:border-l-2 lg:border-transparent lg:pl-4 lg:hover:border-line-strong"
                >
                  <span aria-hidden className="hidden font-mono text-[0.7rem] text-faint lg:inline">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 space-y-14 sm:space-y-16">
          <Section id="start" title="Start">
            <Rules>
              {[
                <>
                  Each key belongs to one network. Resources on the other network answer 404. A key
                  for a network this server has turned off gets <C>403 NETWORK_DISABLED</C>.
                </>,
                <>
                  Agent keys start with <C>ag_</C> and belong to one jar. An agent key can call two
                  routes: <C>POST /v1/jars/&lt;their jar&gt;/charge</C> to charge its jar and{" "}
                  <C>GET /v1/jars/&lt;their jar&gt;</C> to read the budget.
                </>,
                <>
                  Test mode is testnet with an <C>sk_test_…</C> key. Its payments are real testnet
                  transactions, and Shade never fakes one. To test your receiver, press Send test
                  under Webhooks for a <C>webhook.test</C> event, or sign your own fixture with the
                  SDK's <C>signWebhook</C>.
                </>,
                <>
                  <C>POST /v1/invoices</C>, <C>/v1/jars</C> and <C>/v1/jars/:id/charge</C> accept an{" "}
                  <C>Idempotency-Key</C> header. Send the same key and body again and Shade replays
                  the first answer. The same key with a different body gets{" "}
                  <C>422 IDEMPOTENCY_MISMATCH</C>. Shade keeps each key for 24 hours.
                </>,
                <>
                  Lists take <C>?cursor=&amp;limit=</C>. The limit defaults to 25 and goes up to
                  100. A list returns <C>{"{ items, next_cursor }"}</C>, newest first.
                </>,
                <>
                  Each key can make 600 requests a minute. An IP can send 60 requests a minute with
                  a missing or wrong key.
                </>,
              ]}
            </Rules>
            <p className={PROSE}>
              The TypeScript SDK takes and returns camelCase. Install it with{" "}
              <C>npm install shade-zcash-sdk</C>.
            </p>
            <Code label="SDK example">{SDK_EXAMPLE(origin)}</Code>
          </Section>

          <Section id="endpoints" title="Endpoints">
            <p className={PROSE}>
              In the Auth column, <C>ag</C> is a jar's agent key and <C>sk</C> is a merchant key:{" "}
              <C>sk_test_…</C> or <C>sk_live_…</C>.
            </p>
            <EndpointTable />
          </Section>

          <Section id="invoices" title="Invoices">
            <p className={PROSE}>
              An invoice asks for an exact amount of ZEC. Shade answers with a pay page, a ZIP-321
              link and the receive address. The link looks like <C>zcash:…?amount=…&amp;memo=…</C>.
            </p>
            <p className={PROSE}>
              The memo can be up to 495 bytes. Shade appends a short reference such as{" "}
              <C>(shade:7K2Q9MXA)</C>, so every invoice has a unique memo on chain. <C>tag</C> is a
              free label, like <C>payroll</C>, that you can scope grants to.
            </p>
            <Code label="Create an invoice with curl">{CURL_INVOICE(base)}</Code>
            <Code label="Invoice response">{INVOICE_RESPONSE}</Code>
            <p className={PROSE}>
              Status moves from <C>open</C> to <C>paid</C>. When the payer pastes a txid, the
              invoice only becomes <C>paid_unverified</C>, and no webhook fires. It becomes{" "}
              <C>paid</C> when a viewing-key scan finds the payment, with{" "}
              <C>verification: "ivk_scan"</C>. It also becomes <C>paid</C> when you confirm it on
              the desk, with <C>"merchant_accept"</C>.
            </p>
            <p className={PROSE}>
              If you run your own scanner, report a match with{" "}
              <C>POST /v1/invoices/:id/detections</C>. Shade checks it against the chain before it
              settles the invoice.
            </p>
          </Section>

          <Section id="jars" title="Jars">
            <p className={PROSE}>
              {COPY.jarIsLimit} Each charge counts against the cap. Past the cap, the agent gets a
              402.
            </p>
            <Code label="Jar example">{JAR_EXAMPLE}</Code>
            <p className={PROSE}>
              <span className="font-semibold text-fg">Kill.</span> {COPY.killNote} After a kill,
              charges answer <C>409 JAR_CLOSED</C>.
            </p>
          </Section>

          <Section id="grants" title="Grants">
            <p className={PROSE}>
              A grant is a read-only receipt view with an end time. <C>scope</C> is <C>all</C> or an
              invoice label. Set the length with <C>days</C>, from 1 to 90, or with{" "}
              <C>expires_in_sec</C>, from 10 minutes to 90 days.
            </p>
            <p className={PROSE}>
              Shade returns the view link once. The token sits after the <C>#</C>, so it never
              reaches a server log.
            </p>
            <Code label="Grant example">{GRANT_EXAMPLE}</Code>
            <p className={PROSE}>{COPY.grantNote}</p>
          </Section>

          <Section id="webhooks" title="Webhooks">
            <p className={PROSE}>
              Register an https endpoint. Shade shows its signing secret, <C>whsec_…</C>, once.
            </p>
            <p className={PROSE}>
              Shade creates one <C>invoice.paid</C> event per invoice, plus a <C>webhook.test</C>{" "}
              event when you ask for one. It delivers each event at least once. The body never
              carries the payer's address or the memo text, only the memo's hash.
            </p>
            <Code label="Webhook body">{WEBHOOK_BODY}</Code>
            <dl className="divide-y divide-line rounded-md border border-line">
              {HEADERS.map((header) => (
                <div
                  key={header.name}
                  className="grid gap-2 p-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-6 sm:p-5"
                >
                  <dt className="space-y-1">
                    <code className="block text-[0.8rem] wrap-anywhere text-fg">{header.name}</code>
                    {header.value ? (
                      <code className="block text-xs font-light wrap-anywhere text-faint">
                        {header.value}
                      </code>
                    ) : null}
                  </dt>
                  <dd className="text-muted">{header.body}</dd>
                </div>
              ))}
            </dl>
            <p className={PROSE}>
              Answer 2xx within 10 seconds. Shade retries anything else with backoff for about three
              days. A 410 Gone turns the endpoint off. Shade does not follow redirects.
            </p>
            <Code label="Verify with the SDK">{WEBHOOK_VERIFY_SDK}</Code>
            <Code label="Verify with Node.js only">{WEBHOOK_VERIFY}</Code>
            <Code label="Verify with Python">{WEBHOOK_VERIFY_PYTHON}</Code>
            <Code label="Verify with Go">{WEBHOOK_VERIFY_GO}</Code>
          </Section>

          <Section id="errors" title="Errors">
            <p className={PROSE}>
              Every error is an HTTP status plus a JSON body. <C>error</C> is a stable code.{" "}
              <C>message</C> is a plain sentence you can show to people.
            </p>
            <p className={PROSE}>
              Validation errors add <C>issues</C>, a list of field paths that never includes your
              values. Rate limits and chain outages add <C>retry_after</C>.
            </p>
            <Code label="Error body">{ERROR_BODY}</Code>
            <div
              className="overflow-x-auto rounded-md border border-line-strong"
              tabIndex={0}
              aria-label="Error codes"
            >
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line-strong bg-surface">
                  <tr>
                    <th scope="col" className={cn(EYEBROW, "w-24 px-4 py-3 font-normal")}>
                      Status
                    </th>
                    <th scope="col" className={cn(EYEBROW, "px-4 py-3 font-normal")}>
                      Codes
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {ERROR_GROUPS.map((group) => (
                    <tr key={group.status} className="align-top">
                      <th
                        scope="row"
                        className="px-4 py-3.5 text-left font-display text-2xl leading-none text-fg tabular"
                      >
                        {group.status}
                      </th>
                      <td className="px-4 py-3">
                        <ul className="flex flex-wrap gap-1.5">
                          {group.codes.map((code) => (
                            <li key={code}>
                              <code className="inline-block rounded-[3px] bg-surface-2 px-1.5 py-0.5 text-xs font-light wrap-anywhere text-fg">
                                {code}
                              </code>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="limits" title="Honest limits">
            <div className="theme-paper rounded-lg p-5 sm:p-7">
              <Rules>
                {[
                  "Shade is not a wallet. It holds no seeds and no spending keys. Payments go straight to your Unified Address.",
                  COPY.lag,
                  COPY.chainPrivacyNote,
                  COPY.quantum,
                  "Shade refuses transparent addresses. It handles ZEC only. Testnet is the default.",
                ]}
              </Rules>
            </div>
          </Section>
        </article>
      </div>
    </PublicPage>
  );
}
