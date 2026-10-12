/** Public API `/v1` (PRD §9): bearer keys, CORS for any origin without credentials, network scoping. */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config } from "../platform/config.ts";
import type { Db } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import {
  type AppEnv,
  apiKeyAuth,
  idempotency,
  jsonBody,
  rateLimit,
  rateLimitedError,
} from "../platform/http.ts";
import { consumeRateLimit, ipBucket } from "../platform/rate-limit.ts";
import type { Services } from "../services/index.ts";
import {
  ChargeBody,
  DetectionBody,
  EmptyBody,
  GrantBody,
  InvoiceBody,
  JarBody,
  TagBody,
  WebhookBody,
  expiresAfterQuery,
  idParam,
  keyScope,
  pageQuery,
  principalOf,
  statusQuery,
} from "./support.ts";

/** Failed `/v1` authentications per client IP per minute before 429. */
const AUTH_FAILURES_PER_MIN = 60;

export function v1Routes(deps: { config: Config; db: Db; services: Services }): Hono<AppEnv> {
  const { config, db, services } = deps;
  const { clock } = services;
  const idem = idempotency(db, clock);
  const v1 = new Hono<AppEnv>();

  v1.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["authorization", "content-type", "idempotency-key", "accept"],
      exposeHeaders: ["x-request-id", "retry-after", "idempotent-replayed"],
      maxAge: 600,
    }),
  );

  // Public: resolving name.shade needs no key.
  v1.get(
    "/tags/:name",
    rateLimit(db, {
      name: "pub:tag:ip",
      limit: 60,
      windowSec: 60,
      key: (c) => ipBucket(c.get("clientIp")),
      now: clock,
    }),
    async (c) => c.json(await services.tags.resolve(c.req.param("name"))),
  );

  // Failed attempts are limited per IP; valid keys are limited per key below.
  v1.use(
    "*",
    apiKeyAuth(
      (token) => services.keys.resolvePrincipal(token),
      config,
      async (c) => {
        const ip = ipBucket(c.get("clientIp"));
        if (ip === null) return;
        const result = await consumeRateLimit(
          db,
          `v1:auth:ip:${ip}`,
          AUTH_FAILURES_PER_MIN,
          60,
          clock(),
        );
        if (!result.ok) throw rateLimitedError(result.retryAfterSec);
      },
    ),
  );
  v1.use(
    "*",
    rateLimit(db, {
      name: "v1:key",
      limit: 600,
      windowSec: 60,
      key: (c) => c.get("principal")?.keyId ?? null,
      now: clock,
    }),
  );
  // Agent keys may only charge their own jar and read its budget.
  v1.use("*", async (c, next) => {
    const principal = principalOf(c);
    if (principal.kind === "agent") {
      const own = `/v1/jars/${principal.jarId}`;
      const allowed =
        (c.req.method === "POST" && c.req.path === `${own}/charge`) ||
        (c.req.method === "GET" && c.req.path === own);
      if (!allowed) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Agent keys can only charge their own jar and read its budget.",
        );
      }
    }
    await next();
  });

  // Invoices ----------------------------------------------------------------------------------

  v1.post("/invoices", async (c) => {
    const body = await jsonBody(c, InvoiceBody);
    const scope = keyScope(c);
    const plan = await services.invoices.prepare(scope.merchantId, scope.network, body);
    return idem.run(c, async (sql) => ({
      status: 201,
      body: await services.invoices.insert(sql, plan),
    }));
  });

  v1.get("/invoices", async (c) => {
    const scope = keyScope(c);
    return c.json(
      await services.invoices.list(
        scope.merchantId,
        scope.network,
        statusQuery(c),
        pageQuery(c),
        expiresAfterQuery(c),
      ),
    );
  });

  v1.get("/invoices/:id", async (c) =>
    c.json(await services.invoices.get(keyScope(c), idParam(c, "id"))),
  );

  v1.post("/invoices/:id/cancel", async (c) => {
    await jsonBody(c, EmptyBody);
    const scope = keyScope(c);
    const row = await services.invoices.row(scope, idParam(c, "id"));
    if (row.jar_id !== null) {
      const { invoice } = await services.jars.cancelCharge(scope, row.jar_id, row.id);
      return c.json(invoice);
    }
    return c.json(await services.invoices.cancelOpen(scope, row.id));
  });

  v1.post("/invoices/:id/detections", async (c) => {
    const body = await jsonBody(c, DetectionBody);
    return c.json(await services.settlement.reportDetection(keyScope(c), idParam(c, "id"), body));
  });

  // Jars --------------------------------------------------------------------------------------

  v1.post("/jars", async (c) => {
    const body = await jsonBody(c, JarBody);
    const scope = keyScope(c);
    const plan = await services.jars.prepareCreate(scope.merchantId, scope.network, body);
    return idem.run(c, async (sql) => ({
      status: 201,
      body: await services.jars.insert(sql, plan),
    }));
  });

  v1.post("/jars/:id/charge", async (c) => {
    const body = await jsonBody(c, ChargeBody);
    const scope = keyScope(c);
    const plan = services.jars.prepareCharge(
      scope.merchantId,
      scope.network,
      idParam(c, "id"),
      body,
    );
    return idem.run(c, async (sql) => ({
      status: 201,
      body: await services.jars.charge(sql, plan),
    }));
  });

  v1.get("/jars/:id", async (c) => c.json(await services.jars.get(keyScope(c), idParam(c, "id"))));

  v1.post("/jars/:id/kill", async (c) => {
    await jsonBody(c, EmptyBody);
    return c.json(await services.jars.kill(keyScope(c), idParam(c, "id")));
  });

  // Grants, webhooks, tags ----------------------------------------------------------------------

  v1.post("/grants", async (c) => {
    const body = await jsonBody(c, GrantBody);
    const scope = keyScope(c);
    return c.json(await services.grants.create(scope.merchantId, scope.network, body), 201);
  });

  v1.post("/grants/:id/revoke", async (c) => {
    await jsonBody(c, EmptyBody);
    return c.json(await services.grants.revoke(keyScope(c), idParam(c, "id")));
  });

  v1.post("/webhooks", async (c) => {
    const body = await jsonBody(c, WebhookBody);
    const scope = keyScope(c);
    return c.json(
      await services.webhooks.createEndpoint(scope.merchantId, scope.network, body.url),
      201,
    );
  });

  // Listing and deleting let a setup script find and replace endpoints (at most 5 per network).
  v1.get("/webhooks", async (c) => {
    const scope = keyScope(c);
    return c.json(await services.webhooks.listEndpoints(scope.merchantId, scope.network));
  });

  v1.delete("/webhooks/:id", async (c) => {
    const scope = keyScope(c);
    await services.webhooks.deleteEndpoint(scope.merchantId, idParam(c, "id"), scope.network);
    return c.body(null, 204);
  });

  v1.post("/tags", async (c) => {
    const body = await jsonBody(c, TagBody);
    const scope = keyScope(c);
    return c.json(await services.tags.create(scope.merchantId, scope.network, body.name), 201);
  });

  return v1;
}
