/**
 * The server process against a real Postgres (pg pool): a failed start must exit promptly instead
 * of lingering on the pool's idle client. Runs only when TEST_DATABASE_URL is set.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type Server, createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, createDb } from "../../src/platform/db.ts";
import { runMigrations } from "../../src/platform/migrate.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const SERVER = fileURLToPath(new URL("../../src/bin/server.ts", import.meta.url));

describe.skipIf(!databaseUrl)("server process on a real Postgres server", () => {
  const schema = `shade_server_${randomBytes(4).toString("hex")}`;
  // Built in beforeAll: the describe body runs at collection even when the suite is skipped.
  let url: URL;
  let admin: Db;
  let blocker: Server;
  let port: number;

  beforeAll(async () => {
    url = new URL(databaseUrl ?? "");
    url.searchParams.set("options", `-c search_path=${schema}`);
    admin = await createDb({ databaseUrl: databaseUrl ?? null, pgliteDir: null, env: "test" });
    await admin.query(`create schema ${schema}`);
    const db = await createDb({ databaseUrl: url.toString(), pgliteDir: null, env: "test" });
    try {
      await runMigrations(db);
    } finally {
      await db.close();
    }
    blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    port = (blocker.address() as AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.close();
  });

  it("exits 1 within seconds when the port is taken after the pool was used", async () => {
    const started = Date.now();
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: url.toString(),
        DATABASE_URL_UNPOOLED: "",
        HOST: "127.0.0.1",
        PORT: String(port),
        SHADE_WORKER: "off",
      },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill(), 20_000);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    expect(code).toBe(1);
    // The pg pool keeps an idle client for 30 s; a prompt exit means it was closed.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
