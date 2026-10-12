/** `/api/config` and the anonymous surfaces: pay page, payer txid claim, grant view and export. */
import { Hono } from "hono";
import type { Db } from "../platform/db.ts";
import { type AppEnv, jsonBody, rateLimit } from "../platform/http.ts";
import { ipBucket } from "../platform/rate-limit.ts";
import type { Services } from "../services/index.ts";
import { TokenBody, TxidBody, idParam, isShadeId } from "./support.ts";

export function publicRoutes(deps: { db: Db; services: Services }): Hono<AppEnv> {
  const { db, services } = deps;
  const { clock } = services;
  const api = new Hono<AppEnv>();

  const perIp = (name: string, limit: number, windowSec: number) =>
    rateLimit(db, { name, limit, windowSec, key: (c) => ipBucket(c.get("clientIp")), now: clock });

  api.get("/config", async (c) => c.json(await services.config.appConfig()));

  api.get("/public/invoices/:id", perIp("pub:inv:ip", 120, 60), async (c) =>
    c.json(await services.invoices.getPublic(idParam(c, "id"))),
  );

  api.post(
    "/public/invoices/:id/txid",
    perIp("pub:txid:ip", 10, 60),
    rateLimit(db, {
      name: "pub:txid:inv",
      limit: 5,
      windowSec: 600,
      key: (c) => {
        const id = c.req.param("id");
        return isShadeId(id) ? id : null;
      },
      now: clock,
    }),
    async (c) => {
      const id = idParam(c, "id");
      const body = await jsonBody(c, TxidBody);
      return c.json(await services.settlement.submitPayerTxid(id, body.txid));
    },
  );

  // Grant tokens travel only in request bodies, never in paths or query strings.
  api.post("/public/grants/view", perIp("pub:grant:ip", 30, 60), async (c) => {
    const body = await jsonBody(c, TokenBody);
    return c.json(await services.grants.view(body.token));
  });

  api.post("/public/grants/export", perIp("pub:grant:ip", 30, 60), async (c) => {
    const body = await jsonBody(c, TokenBody);
    const exported = await services.grants.exportCsv(body.token);
    return c.body(exported.csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exported.filename}"`,
    });
  });

  return api;
}
