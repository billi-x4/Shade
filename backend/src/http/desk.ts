/** Merchant desk API `/api/desk` (Better Auth session cookie, same-origin only). */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { Auth } from "../platform/auth.ts";
import type { Config } from "../platform/config.ts";
import type { Db } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import {
  type AppEnv,
  jsonBody,
  rateLimitedError,
  requireFreshSession,
  sessionAuth,
} from "../platform/http.ts";
import { consumeRateLimit } from "../platform/rate-limit.ts";
import type { Services } from "../services/index.ts";
import type { DeskUser, MerchantRecord } from "../services/merchants.ts";
import {
  AcceptBody,
  AddressBody,
  EmptyBody,
  GrantBody,
  InvoiceBody,
  JarBody,
  KeyBody,
  NetworkBody,
  ProfileBody,
  TagBody,
  ViewingKeyBody,
  WebhookBody,
  idParam,
  networkParam,
  networkQuery,
  pageQuery,
  statusQuery,
} from "./support.ts";

const FRESH_SESSION_SEC = 900;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function userOf(c: Context<AppEnv>): DeskUser {
  const user = c.get("user");
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Sign in to continue.");
  return user;
}

/** The signed-in user's merchant, resolved once per request by the desk middleware. */
const requestMerchants = new WeakMap<object, MerchantRecord>();

function merchantOf(c: Context<AppEnv>): MerchantRecord {
  const merchant = requestMerchants.get(c);
  if (!merchant) throw new Error("desk merchant was not resolved for this request");
  return merchant;
}

export function deskRoutes(deps: {
  config: Config;
  db: Db;
  auth: Auth;
  services: Services;
}): Hono<AppEnv> {
  const { config, db, auth, services } = deps;
  const { clock } = services;
  const fresh = requireFreshSession(FRESH_SESSION_SEC, clock);
  const desk = new Hono<AppEnv>();

  /** Per-merchant fixed-window limit (bucket `${name}:<merchant_id>`). */
  const merchantLimit =
    (
      name: string,
      limit: number,
      windowSec: number,
      onlyUnsafe = false,
    ): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      if (!onlyUnsafe || !SAFE_METHODS.has(c.req.method)) {
        const bucket = `${name}:${merchantOf(c).id}`;
        const result = await consumeRateLimit(db, bucket, limit, windowSec, clock());
        if (!result.ok) throw rateLimitedError(result.retryAfterSec);
      }
      await next();
    };

  /** Applies the fresh-session gate only when `needed` (e.g. switching to mainnet). */
  const freshWhen = async (c: Context<AppEnv>, needed: boolean) => {
    if (needed) await fresh(c, async () => {});
  };

  desk.use("*", sessionAuth(auth, { requireVerifiedEmail: config.requireEmailVerification }));
  // The Better Auth hook creates the merchant at sign-up; this repairs a sign-up whose hook failed.
  desk.use("*", async (c, next) => {
    requestMerchants.set(c, await services.merchants.ensure(userOf(c)));
    await next();
  });
  desk.use("*", merchantLimit("desk:req", 600, 60));
  desk.use("*", merchantLimit("desk:mut", 120, 60, true));

  // Me & settings -----------------------------------------------------------------------------

  desk.get("/me", async (c) => c.json(await services.merchants.me(userOf(c), merchantOf(c).id)));

  desk.put("/settings/profile", async (c) => {
    const body = await jsonBody(c, ProfileBody);
    return c.json(
      await services.merchants.updateProfile(userOf(c), merchantOf(c).id, body.display_name),
    );
  });

  desk.put("/settings/address", fresh, async (c) => {
    const body = await jsonBody(c, AddressBody);
    return c.json(
      await services.merchants.saveAddress(userOf(c), merchantOf(c).id, body.network, body.address),
    );
  });

  desk.put("/settings/network", async (c) => {
    const body = await jsonBody(c, NetworkBody);
    await freshWhen(c, body.network === "mainnet");
    return c.json(
      await services.merchants.switchNetwork(userOf(c), merchantOf(c).id, body.network),
    );
  });

  // Invoices ----------------------------------------------------------------------------------

  desk.get("/invoices", async (c) => {
    const merchant = merchantOf(c);
    return c.json(
      await services.invoices.list(
        merchant.id,
        networkQuery(c, merchant.network),
        statusQuery(c),
        pageQuery(c),
      ),
    );
  });

  desk.post("/invoices", async (c) => {
    const body = await jsonBody(c, InvoiceBody);
    const merchant = merchantOf(c);
    return c.json(await services.invoices.create(merchant.id, merchant.network, body), 201);
  });

  desk.post("/invoices/:id/cancel", async (c) => {
    await jsonBody(c, EmptyBody);
    const scope = { merchantId: merchantOf(c).id, network: null };
    const row = await services.invoices.row(scope, idParam(c, "id"));
    if (row.jar_id !== null) {
      const { invoice } = await services.jars.cancelCharge(scope, row.jar_id, row.id);
      return c.json(invoice);
    }
    return c.json(await services.invoices.cancelOpen(scope, row.id));
  });

  desk.post("/invoices/:id/accept", async (c) => {
    const body = await jsonBody(c, AcceptBody);
    return c.json(
      await services.settlement.acceptClaim(merchantOf(c).id, idParam(c, "id"), body.txid ?? null),
    );
  });

  desk.post("/invoices/:id/reject", async (c) => {
    await jsonBody(c, EmptyBody);
    return c.json(await services.settlement.rejectClaim(merchantOf(c).id, idParam(c, "id")));
  });

  // Jars --------------------------------------------------------------------------------------

  desk.get("/jars", async (c) => {
    const merchant = merchantOf(c);
    return c.json(await services.jars.list(merchant.id, networkQuery(c, merchant.network)));
  });

  desk.post("/jars", async (c) => {
    const body = await jsonBody(c, JarBody);
    const merchant = merchantOf(c);
    return c.json(await services.jars.create(merchant.id, merchant.network, body), 201);
  });

  desk.post("/jars/:id/kill", async (c) => {
    await jsonBody(c, EmptyBody);
    const scope = { merchantId: merchantOf(c).id, network: null };
    return c.json(await services.jars.kill(scope, idParam(c, "id")));
  });

  desk.get("/jars/:id/charges", async (c) =>
    c.json(await services.jars.charges(merchantOf(c).id, idParam(c, "id"), pageQuery(c))),
  );

  desk.post("/jars/:id/charges/:chargeId/cancel", async (c) => {
    await jsonBody(c, EmptyBody);
    const scope = { merchantId: merchantOf(c).id, network: null };
    const { jar } = await services.jars.cancelCharge(
      scope,
      idParam(c, "id"),
      idParam(c, "chargeId"),
    );
    return c.json(jar);
  });

  // Grants ------------------------------------------------------------------------------------

  desk.get("/grants", async (c) => {
    const merchant = merchantOf(c);
    return c.json(await services.grants.list(merchant.id, networkQuery(c, merchant.network)));
  });

  desk.post("/grants", async (c) => {
    const body = await jsonBody(c, GrantBody);
    await freshWhen(c, services.grants.durationSec(body) > 86_400);
    const merchant = merchantOf(c);
    return c.json(await services.grants.create(merchant.id, merchant.network, body), 201);
  });

  desk.post("/grants/:id/revoke", async (c) => {
    await jsonBody(c, EmptyBody);
    const scope = { merchantId: merchantOf(c).id, network: null };
    return c.json(await services.grants.revoke(scope, idParam(c, "id")));
  });

  // Webhooks ----------------------------------------------------------------------------------

  desk.get("/webhooks", async (c) => {
    const merchant = merchantOf(c);
    return c.json(
      await services.webhooks.listEndpoints(merchant.id, networkQuery(c, merchant.network)),
    );
  });

  desk.post("/webhooks", fresh, async (c) => {
    const body = await jsonBody(c, WebhookBody);
    const merchant = merchantOf(c);
    return c.json(
      await services.webhooks.createEndpoint(merchant.id, merchant.network, body.url),
      201,
    );
  });

  desk.post("/webhooks/test", merchantLimit("desk:whtest", 5, 60), async (c) => {
    await jsonBody(c, EmptyBody);
    const merchant = merchantOf(c);
    return c.json(await services.webhooks.sendTest(merchant.id, merchant.network));
  });

  desk.get("/webhooks/deliveries", async (c) => {
    const merchant = merchantOf(c);
    return c.json(
      await services.webhooks.deliveries(
        merchant.id,
        networkQuery(c, merchant.network),
        pageQuery(c),
      ),
    );
  });

  desk.delete("/webhooks/:id", async (c) => {
    await services.webhooks.deleteEndpoint(merchantOf(c).id, idParam(c, "id"));
    return c.body(null, 204);
  });

  // Tags --------------------------------------------------------------------------------------

  desk.get("/tags", async (c) =>
    c.json(await services.tags.list(merchantOf(c).id, networkQuery(c, null))),
  );

  desk.post("/tags", async (c) => {
    const body = await jsonBody(c, TagBody);
    const merchant = merchantOf(c);
    return c.json(await services.tags.create(merchant.id, merchant.network, body.name), 201);
  });

  // API keys ----------------------------------------------------------------------------------

  desk.get("/keys", async (c) =>
    c.json(await services.keys.list(merchantOf(c).id, networkQuery(c, null))),
  );

  desk.post("/keys", fresh, merchantLimit("desk:keys", 10, 3600), async (c) => {
    const body = await jsonBody(c, KeyBody);
    return c.json(await services.keys.issue(merchantOf(c).id, body), 201);
  });

  desk.post("/keys/:id/revoke", async (c) => {
    await jsonBody(c, EmptyBody);
    return c.json(await services.keys.revoke(merchantOf(c).id, idParam(c, "id")));
  });

  // Viewing keys ------------------------------------------------------------------------------

  desk.get("/viewing-keys", async (c) => c.json(await services.viewingKeys.list(merchantOf(c).id)));

  desk.put("/viewing-keys/:network", fresh, async (c) => {
    const body = await jsonBody(c, ViewingKeyBody);
    return c.json(await services.viewingKeys.upload(merchantOf(c).id, networkParam(c), body));
  });

  desk.delete("/viewing-keys/:network", async (c) => {
    await services.viewingKeys.remove(merchantOf(c).id, networkParam(c));
    return c.body(null, 204);
  });

  return desk;
}
