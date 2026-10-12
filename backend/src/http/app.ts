/**
 * The Hono application: one API for the web app (`/api`, cookie sessions, same origin), SDK and
 * agents (`/v1`, bearer keys, CORS) and probes (`/healthz`, `/readyz`).
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Auth } from "../platform/auth.ts";
import type { Config } from "../platform/config.ts";
import type { Db } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import {
  type AppEnv,
  edgeGuard,
  errorHandler,
  noStore,
  notFoundHandler,
  requestContext,
  requireSameOrigin,
} from "../platform/http.ts";
import type { Logger } from "../platform/logger.ts";
import { pendingMigrations } from "../platform/migrate.ts";
import type { Services } from "../services/index.ts";
import { deskRoutes } from "./desk.ts";
import { publicRoutes } from "./public.ts";
import { v1Routes } from "./v1.ts";

/** Better Auth reads whole request bodies itself; they get the same 16 KB cap as jsonBody. */
const AUTH_BODY_MAX_BYTES = 16 * 1024;

/** Readiness: the database answers, every migration is applied, and how old each worker beat is. */
async function readiness(db: Db, now: Date) {
  try {
    await db`select 1`;
    const pending = await pendingMigrations(db);
    const beats = await db<{ name: string; last_seen_at: Date }>`
      select name, last_seen_at from worker_heartbeats order by name`;
    const workers = Object.fromEntries(
      beats.map((beat) => [
        beat.name,
        {
          last_seen_at: beat.last_seen_at.toISOString(),
          age_sec: Math.max(0, Math.round((now.getTime() - beat.last_seen_at.getTime()) / 1000)),
        },
      ]),
    );
    return { ok: pending.length === 0, database: "ok", pending_migrations: pending, workers };
  } catch {
    return { ok: false, database: "unavailable", pending_migrations: [], workers: {} };
  }
}

export function createApp(deps: {
  config: Config;
  logger: Logger;
  db: Db;
  auth: Auth;
  services: Services;
}): Hono<AppEnv> {
  const { config, logger, db, auth, services } = deps;
  const app = new Hono<AppEnv>();

  app.use("*", requestContext({ logger, config }));
  app.use("*", noStore());
  app.use("*", secureHeaders());
  app.onError(errorHandler());
  app.notFound(notFoundHandler());

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    const report = await readiness(db, services.clock());
    return c.json(report, report.ok ? 200 : 503);
  });

  // Cookie surfaces: optional edge secret, then CSRF origin checks (Better Auth included).
  app.use("/api/*", edgeGuard(config));
  app.use("/api/*", requireSameOrigin(config));
  app.use(
    "/api/auth/*",
    bodyLimit({
      maxSize: AUTH_BODY_MAX_BYTES,
      onError: () => {
        throw new AppError(413, "PAYLOAD_TOO_LARGE", "The request body is larger than 16 KB.");
      },
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route("/api", publicRoutes({ db, services }));
  app.route("/api/desk", deskRoutes({ config, db, auth, services }));

  app.route("/v1", v1Routes({ config, db, services }));
  return app;
}
