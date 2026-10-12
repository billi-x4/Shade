import { getMigrations } from "better-auth/db/migration";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../../src/contract/index.ts";
import { type Auth, createAuth } from "../../src/platform/auth.ts";
import { type Config, loadConfig } from "../../src/platform/config.ts";
import { newId } from "../../src/platform/crypto.ts";
import type { Db } from "../../src/platform/db.ts";
import {
  type AppEnv,
  errorHandler,
  noStore,
  notFoundHandler,
  requestContext,
  requireFreshSession,
  requireSameOrigin,
  sessionAuth,
} from "../../src/platform/http.ts";
import { createLogger } from "../../src/platform/logger.ts";
import type { MailMessage } from "../../src/platform/mailer.ts";
import { createTestDb } from "../support/test-db.ts";
import { type Background, createBackground } from "../../src/services/background.ts";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";

interface Harness {
  db: Db;
  auth: Auth;
  app: Hono<AppEnv>;
  /** Every message handed to the mailer, recorded when send() is called. */
  mail: MailMessage[];
  /** Messages whose send() has finished. */
  sent: MailMessage[];
  background: Background;
  config: Config;
  close(): Promise<void>;
}

interface HarnessOptions {
  /** send() finishes when this settles (a slow mail provider); a rejection is a failed send. */
  mailProvider?: () => Promise<void>;
}

async function harness(
  env: Record<string, string> = {},
  opts: HarnessOptions = {},
): Promise<Harness> {
  const db = await createTestDb();
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", APP_ORIGIN: ORIGIN, ...env });
  const logger = createLogger({ logLevel: "silent", env: "test" });
  const background = createBackground(logger);
  const mail: MailMessage[] = [];
  const sent: MailMessage[] = [];
  const auth = createAuth({
    config,
    db,
    logger,
    background,
    mailer: {
      send: async (msg) => {
        mail.push(msg);
        await opts.mailProvider?.();
        sent.push(msg);
      },
    },
    onUserCreated: async (user) => {
      await db`insert into merchants (id, user_id, network)
        values (${newId("m")}, ${user.id}, ${config.defaultNetwork})
        on conflict (user_id) do nothing`;
    },
  });

  const app = new Hono<AppEnv>();
  app.use("*", requestContext({ logger, config }));
  app.use("*", noStore());
  app.onError(errorHandler());
  app.notFound(notFoundHandler());
  app.use("/api/*", requireSameOrigin(config));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/api/desk/me", sessionAuth(auth, { requireVerifiedEmail: false }), (c) =>
    c.json({ user: c.get("user"), session: c.get("session") }),
  );
  app.get("/api/desk/verified", sessionAuth(auth, { requireVerifiedEmail: true }), (c) =>
    c.json({ ok: true }),
  );
  app.post(
    "/api/desk/sensitive",
    sessionAuth(auth, { requireVerifiedEmail: false }),
    requireFreshSession(),
    (c) => c.json({ ok: true }),
  );
  const close = async () => {
    await background.idle();
    await db.close();
  };
  return { db, auth, app, mail, sent, background, config, close };
}

function socketFrom(ip: string) {
  return { incoming: { socket: { remoteAddress: ip } } };
}

function cookieHeader(res: Response, previous = ""): string {
  const jar = new Map(
    previous
      .split("; ")
      .filter(Boolean)
      .map((pair) => pair.split("=") as [string, string]),
  );
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const [name, ...rest] = (pair ?? "").split("=");
    const value = rest.join("=");
    if (!name) continue;
    if (value === "" || /max-age=0/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function call(
  h: Harness,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; cookie?: string; ip?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(
    h.app.request(
      path,
      { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
      socketFrom(opts.ip ?? "198.51.100.10"),
    ),
  );
}

function tokenFromLink(text: string, pattern: RegExp): { url: URL; token: string } {
  const link = text.split("\n").find((line) => pattern.test(line));
  if (!link) throw new Error("no link in email");
  const url = new URL(link);
  return { url, token: url.searchParams.get("token") ?? "" };
}

describe("Better Auth on PGlite (all migrations)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it("has nothing left to migrate for this configuration", async () => {
    const plan = await getMigrations(h.auth.options, { throwOnUnsafe: false });
    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.toBeAddedIndexes).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
  });

  it("signs up, creates the merchant, and sends a verification link to APP_ORIGIN", async () => {
    const res = await call(h, "POST", "/api/auth/sign-up/email", {
      body: {
        email: "Owner@Example.com",
        password: PASSWORD,
        name: "Owner",
        callbackURL: "https://evil.example",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = (await res.json()) as {
      token: string | null;
      user: { id: string; email: string };
    };
    expect(body.token).toBeNull();
    expect(body.user.email).toBe("owner@example.com");

    const merchants = await h.db<{
      user_id: string;
      network: string;
      webhook_secret: string | null;
    }>`
      select user_id, network, webhook_secret from merchants where user_id = ${body.user.id}`;
    expect(merchants).toEqual([
      { user_id: body.user.id, network: "testnet", webhook_secret: null },
    ]);
    const accounts =
      await h.db`select "providerId", "accountId" from account where "userId" = ${body.user.id}`;
    expect(accounts).toEqual([{ providerId: "credential", accountId: body.user.id }]);

    expect(h.mail).toHaveLength(1);
    const verify = tokenFromLink(h.mail[0]!.text, /verify-email/);
    expect(h.mail[0]!.to).toBe("owner@example.com");
    expect(verify.url.origin).toBe(ORIGIN);
    expect(verify.url.pathname).toBe("/api/auth/verify-email");
    expect(verify.url.searchParams.get("callbackURL")).toBe(`${ORIGIN}/desk?verified=1`);
    expect(verify.token.length).toBeGreaterThan(20);
  });

  it("answers a duplicate sign-up generically without a second user", async () => {
    const res = await call(h, "POST", "/api/auth/sign-up/email", {
      body: { email: "owner@example.com", password: PASSWORD, name: "Someone else" },
    });
    expect(res.status).toBe(200);
    const users = await h.db`select id from "user" where email = ${"owner@example.com"}`;
    expect(users).toHaveLength(1);
  });

  it("enforces the 12-character minimum password", async () => {
    const res = await call(h, "POST", "/api/auth/sign-up/email", {
      body: { email: "short@example.com", password: "elevenchars", name: "Short" },
      ip: "198.51.100.11",
    });
    expect(res.status).toBe(400);
  });

  it("refuses cross-site auth requests before Better Auth sees them", async () => {
    const res = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email: "owner@example.com", password: PASSWORD },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiErrorBody).error).toBe("FORBIDDEN_ORIGIN");
  });

  it("signs in, reads the session from the database, and signs out", async () => {
    const signIn = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email: "owner@example.com", password: PASSWORD },
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieHeader(signIn);
    expect(cookie).toMatch(/^shade\.session_token=/);
    expect(signIn.headers.getSetCookie().join("\n")).toMatch(/HttpOnly/i);

    const me = await call(h, "GET", "/api/desk/me", { cookie, origin: null });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      user: { email: string; emailVerified: boolean };
      session: { id: string; createdAt: string };
    };
    expect(meBody.user).toMatchObject({ email: "owner@example.com", emailVerified: false });
    expect(Date.now() - Date.parse(meBody.session.createdAt)).toBeLessThan(60_000);

    const sessions = await h.db<{ ipAddress: string | null }>`select "ipAddress" from session`;
    expect(sessions.map((s) => s.ipAddress)).toContain("198.51.100.10");

    const unverified = await call(h, "GET", "/api/desk/verified", { cookie, origin: null });
    expect(unverified.status).toBe(403);
    expect(((await unverified.json()) as ApiErrorBody).error).toBe("EMAIL_UNVERIFIED");

    const fresh = await call(h, "POST", "/api/desk/sensitive", { cookie });
    expect(fresh.status).toBe(200);

    const getSession = await call(h, "GET", "/api/auth/get-session", { cookie, origin: null });
    expect(getSession.status).toBe(200);
    expect(getSession.headers.get("cache-control")).toBe("no-store");
    expect(((await getSession.json()) as { user: { email: string } }).user.email).toBe(
      "owner@example.com",
    );

    const signOut = await call(h, "POST", "/api/auth/sign-out", { cookie, body: {} });
    expect(signOut.status).toBe(200);
    const after = await call(h, "GET", "/api/desk/me", { cookie, origin: null });
    expect(after.status).toBe(401);
    expect(((await after.json()) as ApiErrorBody).error).toBe("UNAUTHORIZED");
  });

  it("verifies the email from the mailed link without signing anyone in", async () => {
    const { url } = tokenFromLink(h.mail[0]!.text, /verify-email/);
    const res = await call(h, "GET", `${url.pathname}${url.search}`, { origin: null });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/desk?verified=1`);
    // The link proves the mailbox, not the password: the user signs in afterwards.
    expect(res.headers.getSetCookie()).toEqual([]);
    // A broken link reaches the SPA with the error (which /desk checks first).
    url.searchParams.set("token", "not-a-token");
    const broken = await call(h, "GET", `${url.pathname}${url.search}`, { origin: null });
    expect(broken.status).toBe(302);
    const brokenAt = new URL(broken.headers.get("location") ?? "");
    expect(`${brokenAt.origin}${brokenAt.pathname}`).toBe(`${ORIGIN}/desk`);
    expect(brokenAt.searchParams.get("error")).toBe("INVALID_TOKEN");
    const signIn = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email: "owner@example.com", password: PASSWORD },
      ip: "198.51.100.14",
    });
    const cookie = cookieHeader(signIn);
    const verified = await call(h, "GET", "/api/desk/verified", { cookie, origin: null });
    expect(verified.status).toBe(200);
  });

  it("resets the password through an APP_ORIGIN link and revokes old sessions", async () => {
    const signIn = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email: "owner@example.com", password: PASSWORD },
      ip: "198.51.100.12",
    });
    const oldCookie = cookieHeader(signIn);
    expect((await call(h, "GET", "/api/desk/me", { cookie: oldCookie, origin: null })).status).toBe(
      200,
    );

    const mailed = h.mail.length;
    const request = await call(h, "POST", "/api/auth/request-password-reset", {
      body: { email: "owner@example.com" },
      ip: "198.51.100.12",
    });
    expect(request.status).toBe(200);
    expect(h.mail).toHaveLength(mailed + 1);
    const reset = tokenFromLink(h.mail[mailed]!.text, /reset-password/);
    expect(`${reset.url.origin}${reset.url.pathname}`).toBe(`${ORIGIN}/reset-password`);

    const unknown = await call(h, "POST", "/api/auth/request-password-reset", {
      body: { email: "nobody@example.com" },
      ip: "198.51.100.12",
    });
    expect(unknown.status).toBe(200);
    expect(h.mail).toHaveLength(mailed + 1);

    const newPassword = "an even longer passphrase";
    const done = await call(h, "POST", "/api/auth/reset-password", {
      body: { newPassword, token: reset.token },
      ip: "198.51.100.12",
    });
    expect(done.status).toBe(200);
    expect((await call(h, "GET", "/api/desk/me", { cookie: oldCookie, origin: null })).status).toBe(
      401,
    );

    const oldPassword = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email: "owner@example.com", password: PASSWORD },
      ip: "198.51.100.13",
    });
    expect(oldPassword.status).toBe(401);
    const signedIn = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email: "owner@example.com", password: newPassword },
      ip: "198.51.100.13",
    });
    expect(signedIn.status).toBe(200);
  });

  it("rate-limits sign-in attempts per client IP in the database", async () => {
    const attempt = (ip: string) =>
      call(h, "POST", "/api/auth/sign-in/email", {
        body: { email: "owner@example.com", password: "wrong password here" },
        ip,
      });
    for (let i = 0; i < 5; i += 1) expect((await attempt("203.0.113.50")).status).toBe(401);
    const limited = await attempt("203.0.113.50");
    expect(limited.status).toBe(429);
    expect((await attempt("203.0.113.51")).status).toBe(401);
    const rows = await h.db<{
      key: string;
      count: number;
    }>`select key, count from "rateLimit" where key like ${"203.0.113.50%"}`;
    expect(rows).toEqual([{ key: "203.0.113.50|/sign-in/email", count: 5 }]);
  });
});

describe("Better Auth with required email verification", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness({ AUTH_REQUIRE_EMAIL_VERIFICATION: "true" });
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it("refuses sign-in until the email is verified", async () => {
    const signUp = await call(h, "POST", "/api/auth/sign-up/email", {
      body: { email: "new@example.com", password: PASSWORD, name: "New" },
    });
    expect(signUp.status).toBe(200);
    const signIn = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email: "new@example.com", password: PASSWORD },
    });
    expect(signIn.status).toBe(403);
    expect(signIn.headers.getSetCookie()).toEqual([]);

    const { url } = tokenFromLink(h.mail[0]!.text, /verify-email/);
    expect((await call(h, "GET", `${url.pathname}${url.search}`, { origin: null })).status).toBe(
      302,
    );
    const retry = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email: "new@example.com", password: PASSWORD },
    });
    expect(retry.status).toBe(200);
  });
});

describe("an account parked on someone else's email (pre-registration takeover)", () => {
  // The attacker signs up first with the victim's email and a password of their choosing, then
  // waits for the victim to sign up and confirm the email.
  const ATTACKER_PASSWORD = "attacker chosen password 1";
  const VICTIM_PASSWORD = "victim chosen password 22";
  let h: Harness;
  let ip = 0;
  /** A fresh client IP per call, so the per-IP auth rate limits never interfere. */
  const nextIp = () => `198.51.100.${100 + (ip++ % 150)}`;

  beforeAll(async () => {
    h = await harness({ AUTH_REQUIRE_EMAIL_VERIFICATION: "true" });
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  const signUp = (email: string, password: string, name = "Shop") =>
    call(h, "POST", "/api/auth/sign-up/email", {
      body: { email, password, name },
      ip: nextIp(),
    });
  const signIn = (email: string, password: string) =>
    call(h, "POST", "/api/auth/sign-in/email", { body: { email, password }, ip: nextIp() });
  const mailTo = (email: string, subject: string) => {
    const message = h.mail.filter((m) => m.to === email && m.subject === subject).at(-1);
    if (!message) throw new Error(`no "${subject}" mail to ${email}`);
    return message;
  };
  const visit = (url: URL, cookie?: string) =>
    call(h, "GET", `${url.pathname}${url.search}`, { origin: null, cookie });
  const sessionsOf = async (email: string) =>
    (
      await h.db<{ n: number }>`select count(*)::int as n from "session" s
        join "user" u on u.id = s."userId" where u.email = ${email}`
    )[0]!.n;

  /** Steps 1 and 2: the attacker parks the account, then the victim signs up. */
  async function parkThenVictimSignsUp(victim: string): Promise<void> {
    expect((await signUp(victim, ATTACKER_PASSWORD, "Refunds: DM @attacker")).status).toBe(200);
    // The parked password is valid; only the unconfirmed email stops it.
    expect((await signIn(victim, ATTACKER_PASSWORD)).status).toBe(403);
    // A session from before verification was required (or any other source) must not survive.
    const context = await h.auth.$context;
    const [user] = await h.db<{ id: string }>`select id from "user" where email = ${victim}`;
    await context.internalAdapter.createSession(user!.id);
    expect(await sessionsOf(victim)).toBe(1);

    const before = h.mail.length;
    const res = await signUp(victim, VICTIM_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(((await res.json()) as { token: unknown }).token).toBeNull();
    await h.background.idle();
    // The mailbox owner is told, and the parked password and its sessions are gone.
    expect(h.mail.slice(before).map((m) => [m.to, m.subject])).toEqual([
      [victim, "Finish setting up Shade"],
    ]);
    expect(await sessionsOf(victim)).toBe(0);
    expect((await signIn(victim, ATTACKER_PASSWORD)).status).toBe(401);
    // So is the name the attacker chose, which pay pages would show as the shop name.
    const [names] = await h.db<{ name: string; display_name: string }>`
      select u.name, m.display_name from "user" u join merchants m on m.user_id = u.id
      where u.email = ${victim}`;
    expect(names).toEqual({ name: "", display_name: "" });
  }

  it("victim resends the verification link and confirms: the parked password never works", async () => {
    const victim = "victim1@example.com";
    await parkThenVictimSignsUp(victim);

    // Step 3: no confirmation link came for the victim's own sign-up, so they ask again.
    const resend = await call(h, "POST", "/api/auth/send-verification-email", {
      body: { email: victim, callbackURL: "/desk/invoices" },
      ip: nextIp(),
    });
    expect(resend.status).toBe(200);
    // Step 4: the link confirms the email but signs nobody in.
    const verify = await visit(
      tokenFromLink(mailTo(victim, "Confirm your email for Shade").text, /verify-email/).url,
    );
    expect(verify.status).toBe(302);
    expect(verify.headers.getSetCookie()).toEqual([]);
    const [row] = await h.db<{ emailVerified: boolean }>`
      select "emailVerified" from "user" where email = ${victim}`;
    expect(row!.emailVerified).toBe(true);

    // Step 5: the attacker's password is dead; so is the one the victim typed at sign-up (it was
    // never stored), so the victim sets one through the mailed link.
    expect((await signIn(victim, ATTACKER_PASSWORD)).status).toBe(401);
    expect((await signIn(victim, VICTIM_PASSWORD)).status).toBe(401);
    const { token } = tokenFromLink(
      mailTo(victim, "Finish setting up Shade").text,
      /reset-password/,
    );
    const reset = await call(h, "POST", "/api/auth/reset-password", {
      body: { newPassword: VICTIM_PASSWORD, token },
      ip: nextIp(),
    });
    expect(reset.status).toBe(200);
    const victimIn = await signIn(victim, VICTIM_PASSWORD);
    expect(victimIn.status).toBe(200);
    const verified = await call(h, "GET", "/api/desk/verified", {
      cookie: cookieHeader(victimIn),
      origin: null,
    });
    expect(verified.status).toBe(200);
    expect((await signIn(victim, ATTACKER_PASSWORD)).status).toBe(401);
  });

  it("victim follows the mailed set-password link: that confirms the email", async () => {
    const victim = "victim2@example.com";
    await parkThenVictimSignsUp(victim);

    const link = tokenFromLink(mailTo(victim, "Finish setting up Shade").text, /reset-password/);
    expect(`${link.url.origin}${link.url.pathname}`).toBe(`${ORIGIN}/reset-password`);
    const reset = await call(h, "POST", "/api/auth/reset-password", {
      body: { newPassword: VICTIM_PASSWORD, token: link.token },
      ip: nextIp(),
    });
    expect(reset.status).toBe(200);
    const [row] = await h.db<{ emailVerified: boolean }>`
      select "emailVerified" from "user" where email = ${victim}`;
    expect(row!.emailVerified).toBe(true);

    const victimIn = await signIn(victim, VICTIM_PASSWORD);
    expect(victimIn.status).toBe(200);
    const cookie = cookieHeader(victimIn);
    expect((await call(h, "GET", "/api/desk/verified", { cookie, origin: null })).status).toBe(200);
    expect((await signIn(victim, ATTACKER_PASSWORD)).status).toBe(401);

    // Re-parking a confirmed account changes nothing: no mail, the owner's password and session stay.
    const before = h.mail.length;
    expect((await signUp(victim, ATTACKER_PASSWORD)).status).toBe(200);
    await h.background.idle();
    expect(h.mail).toHaveLength(before);
    expect((await signIn(victim, ATTACKER_PASSWORD)).status).toBe(401);
    expect((await call(h, "GET", "/api/desk/verified", { cookie, origin: null })).status).toBe(200);
  });

  it("re-parking an unconfirmed account only mails its owner again", async () => {
    const victim = "victim3@example.com";
    await parkThenVictimSignsUp(victim);
    const before = h.mail.length;
    expect((await signUp(victim, ATTACKER_PASSWORD)).status).toBe(200);
    await h.background.idle();
    expect(h.mail.slice(before).map((m) => m.to)).toEqual([victim]);
    expect((await signIn(victim, ATTACKER_PASSWORD)).status).toBe(401);
    // Both mailed links stay usable until one is used.
    const { token } = tokenFromLink(
      mailTo(victim, "Finish setting up Shade").text,
      /reset-password/,
    );
    const reset = await call(h, "POST", "/api/auth/reset-password", {
      body: { newPassword: VICTIM_PASSWORD, token },
      ip: nextIp(),
    });
    expect(reset.status).toBe(200);
    expect((await signIn(victim, VICTIM_PASSWORD)).status).toBe(200);
  });

  it("a verification link opened in a signed-in browser never swaps its session (login CSRF)", async () => {
    // The victim's own confirmed account, signed in.
    const victim = "victim4@example.com";
    expect((await signUp(victim, VICTIM_PASSWORD)).status).toBe(200);
    expect(
      (
        await visit(
          tokenFromLink(mailTo(victim, "Confirm your email for Shade").text, /verify-email/).url,
        )
      ).status,
    ).toBe(302);
    const victimCookie = cookieHeader(await signIn(victim, VICTIM_PASSWORD));
    expect(victimCookie).toMatch(/^shade\.session_token=/);

    // The attacker's own account and its verification link, sent to the victim.
    const attacker = "attacker4@example.com";
    expect((await signUp(attacker, ATTACKER_PASSWORD)).status).toBe(200);
    const link = tokenFromLink(
      mailTo(attacker, "Confirm your email for Shade").text,
      /verify-email/,
    );
    const clicked = await visit(link.url, victimCookie);
    expect(clicked.status).toBe(302);
    expect(clicked.headers.getSetCookie()).toEqual([]);

    const me = await call(h, "GET", "/api/desk/me", { cookie: victimCookie, origin: null });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(victim);
    expect(await sessionsOf(attacker)).toBe(0);
  });

  it("a reset still ends every session when confirming the email fails", async () => {
    const owner = "owner5@example.com";
    expect((await signUp(owner, VICTIM_PASSWORD)).status).toBe(200);
    const context = await h.auth.$context;
    const [user] = await h.db<{ id: string }>`select id from "user" where email = ${owner}`;
    await context.internalAdapter.createSession(user!.id);
    expect(await sessionsOf(owner)).toBe(1);
    // Make the onPasswordReset update fail, as a database error would.
    await h.db.query(`create function shade_test_refuse() returns trigger language plpgsql as
      $$ begin raise exception 'refused'; end $$`);
    await h.db.query(`create trigger shade_test_refuse before update of "emailVerified" on "user"
      for each row when (new."emailVerified" and not old."emailVerified")
      execute function shade_test_refuse()`);
    try {
      expect(
        (
          await call(h, "POST", "/api/auth/request-password-reset", {
            body: { email: owner, redirectTo: "/reset-password" },
            ip: nextIp(),
          })
        ).status,
      ).toBe(200);
      await h.background.idle();
      const { token } = tokenFromLink(
        mailTo(owner, "Reset your Shade password").text,
        /reset-password/,
      );
      const reset = await call(h, "POST", "/api/auth/reset-password", {
        body: { newPassword: "owner chosen password 333", token },
        ip: nextIp(),
      });
      expect(reset.status).toBe(200);
      expect(await sessionsOf(owner)).toBe(0);
      const [row] = await h.db<{ emailVerified: boolean }>`
        select "emailVerified" from "user" where email = ${owner}`;
      expect(row!.emailVerified).toBe(false);
    } finally {
      await h.db.query(`drop trigger shade_test_refuse on "user"`);
      await h.db.query(`drop function shade_test_refuse()`);
    }
  });
});

describe("user name and image limits", () => {
  const NAME_ERROR = "Use a name of at most 128 characters.";
  const IMAGE_ERROR = "Shade does not store profile images.";
  // 128 code points but 256 UTF-16 units: the limit counts characters, not string length.
  const LONGEST_NAME = "\u{1F600}".repeat(128);
  let h: Harness;
  let ipCounter = 0;
  const nextIp = () => `198.51.100.${100 + (ipCounter += 1)}`;

  const signUp = (body: Record<string, unknown>) =>
    call(h, "POST", "/api/auth/sign-up/email", {
      body: { password: PASSWORD, ...body },
      ip: nextIp(),
    });

  const usersWith = async (email: string) =>
    h.db<{ name: string; image: string | null }>`
      select name, image from "user" where email = ${email}`;

  const signedIn = async (email: string): Promise<string> => {
    const res = await call(h, "POST", "/api/auth/sign-in/email", {
      body: { email, password: PASSWORD },
      ip: nextIp(),
    });
    expect(res.status).toBe(200);
    return cookieHeader(res);
  };

  beforeAll(async () => {
    h = await harness();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it("refuses sign-up with a 129-character name and creates no user", async () => {
    const res = await signUp({ email: "long@example.com", name: "a".repeat(129) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: NAME_ERROR });
    expect(await usersWith("long@example.com")).toEqual([]);
    await h.background.idle();
    expect(h.mail.filter((m) => m.to === "long@example.com")).toEqual([]);

    const wide = await signUp({ email: "wide@example.com", name: `${LONGEST_NAME}\u{1F600}` });
    expect(wide.status).toBe(400);
    expect(await usersWith("wide@example.com")).toEqual([]);
  });

  it("accepts a name of exactly 128 characters", async () => {
    const ascii = await signUp({ email: "ascii128@example.com", name: "a".repeat(128) });
    expect(ascii.status).toBe(200);
    expect(await usersWith("ascii128@example.com")).toEqual([
      { name: "a".repeat(128), image: null },
    ]);

    const emoji = await signUp({ email: "emoji128@example.com", name: LONGEST_NAME });
    expect(emoji.status).toBe(200);
    expect(await usersWith("emoji128@example.com")).toEqual([{ name: LONGEST_NAME, image: null }]);
  });

  it("refuses a too-long name the same way whether or not the email has an account", async () => {
    // Sign-up answers a known email generically before it creates anything, so a check that
    // only ran on user creation would answer 400 for new emails and 200 for existing ones.
    const known = await signUp({ email: "ascii128@example.com", name: "b".repeat(129) });
    const unknown = await signUp({ email: "fresh@example.com", name: "b".repeat(129) });
    expect(known.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(await known.text()).toBe(await unknown.text());
    expect(await usersWith("fresh@example.com")).toEqual([]);
    expect(await usersWith("ascii128@example.com")).toEqual([
      { name: "a".repeat(128), image: null },
    ]);
  });

  it("refuses a profile image at sign-up", async () => {
    const res = await signUp({
      email: "picture@example.com",
      name: "Picture",
      image: "https://tracker.example/pixel.png",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: IMAGE_ERROR });
    expect(await usersWith("picture@example.com")).toEqual([]);

    const known = await signUp({
      email: "ascii128@example.com",
      name: "Picture",
      image: "https://tracker.example/pixel.png",
    });
    expect(known.status).toBe(400);
  });

  it("refuses a too-long name or an image on update and keeps the stored user", async () => {
    const signUpRes = await signUp({ email: "update@example.com", name: "Before" });
    expect(signUpRes.status).toBe(200);
    const cookie = await signedIn("update@example.com");
    const update = (body: Record<string, unknown>) =>
      call(h, "POST", "/api/auth/update-user", { body, cookie });

    const long = await update({ name: "c".repeat(129) });
    expect(long.status).toBe(400);
    expect(await long.json()).toMatchObject({ message: NAME_ERROR });
    const notText = await update({ name: { first: "Before" } });
    expect(notText.status).toBe(400);
    const image = await update({ image: "https://tracker.example/pixel.png" });
    expect(image.status).toBe(400);
    expect(await image.json()).toMatchObject({ message: IMAGE_ERROR });
    expect(await usersWith("update@example.com")).toEqual([{ name: "Before", image: null }]);

    // update.before sees only the changed fields: a name alone, or clearing the image, passes.
    expect((await update({ name: LONGEST_NAME })).status).toBe(200);
    expect((await update({ image: null })).status).toBe(200);
    expect(await usersWith("update@example.com")).toEqual([{ name: LONGEST_NAME, image: null }]);
  });

  it("still lets partial internal updates through (email verification)", async () => {
    await h.background.idle();
    const mail = h.mail.find((m) => m.to === "update@example.com");
    const { url } = tokenFromLink(mail!.text, /verify-email/);
    const res = await call(h, "GET", `${url.pathname}${url.search}`, { origin: null });
    expect(res.status).toBe(302);
    const rows = await h.db<{ emailVerified: boolean }>`
      select "emailVerified" from "user" where email = ${"update@example.com"}`;
    expect(rows).toEqual([{ emailVerified: true }]);
  });

  it("guards user rows written without an HTTP request too", async () => {
    const ctx = await h.auth.$context;
    await expect(
      ctx.internalAdapter.createUser(
        {
          email: "internal@example.com",
          name: "d".repeat(129),
          emailVerified: false,
        },
        { method: "admin" },
      ),
    ).rejects.toMatchObject({ statusCode: 400, body: { message: NAME_ERROR } });
    await expect(
      ctx.internalAdapter.createUser(
        {
          email: "internal@example.com",
          name: "Internal",
          image: "https://tracker.example/pixel.png",
          emailVerified: false,
        },
        { method: "admin" },
      ),
    ).rejects.toMatchObject({ statusCode: 400, body: { message: IMAGE_ERROR } });
    expect(await usersWith("internal@example.com")).toEqual([]);
  });
});

/** Resolves with the response, or fails if it is still pending after `ms` (it waited for mail). */
async function answeredWithin(response: Promise<Response>, ms: number): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no response within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([response, late]);
  } finally {
    clearTimeout(timer);
  }
}

describe("auth mail runs after the response (no account-existence timing oracle)", () => {
  // The mail provider never finishes until the end of the test. Every response below must still
  // arrive, so whether a request sent mail cannot show up in its latency.
  let h: Harness;
  let deliver!: () => void;
  // Well above the work these requests do (send-verification-email pads itself to 500 ms).
  const BUDGET_MS = 5_000;

  beforeAll(async () => {
    const held = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    h = await harness({}, { mailProvider: () => held });
  }, 60_000);

  afterAll(async () => {
    deliver();
    await h.close();
  });

  it("answers sign-up for a new email without waiting for the verification mail", async () => {
    const res = await answeredWithin(
      call(h, "POST", "/api/auth/sign-up/email", {
        body: { email: "slow@example.com", password: PASSWORD, name: "Slow" },
        ip: "198.51.100.40",
      }),
      BUDGET_MS,
    );
    expect(res.status).toBe(200);
    expect(h.mail.map((m) => m.to)).toEqual(["slow@example.com"]);
    expect(h.sent).toEqual([]);

    const duplicate = await answeredWithin(
      call(h, "POST", "/api/auth/sign-up/email", {
        body: { email: "slow@example.com", password: PASSWORD, name: "Slow" },
        ip: "198.51.100.40",
      }),
      BUDGET_MS,
    );
    expect(duplicate.status).toBe(200);
    expect(h.mail).toHaveLength(1);
  });

  it("answers password-reset requests for known and unknown emails alike", async () => {
    const before = h.mail.length;
    const known = await answeredWithin(
      call(h, "POST", "/api/auth/request-password-reset", {
        body: { email: "slow@example.com" },
        ip: "198.51.100.41",
      }),
      BUDGET_MS,
    );
    expect(known.status).toBe(200);
    expect(h.mail).toHaveLength(before + 1);
    expect(h.mail.at(-1)!.subject).toBe("Reset your Shade password");

    const unknown = await answeredWithin(
      call(h, "POST", "/api/auth/request-password-reset", {
        body: { email: "nobody@example.com" },
        ip: "198.51.100.41",
      }),
      BUDGET_MS,
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe(await known.text());
    expect(h.mail).toHaveLength(before + 1);
  });

  it("answers a verification resend without waiting for the mail", async () => {
    // Better Auth awaits this send itself (not via its background handler).
    const before = h.mail.length;
    const res = await answeredWithin(
      call(h, "POST", "/api/auth/send-verification-email", {
        body: { email: "slow@example.com" },
        ip: "198.51.100.42",
      }),
      BUDGET_MS,
    );
    expect(res.status).toBe(200);
    expect(h.mail).toHaveLength(before + 1);
    expect(h.sent).toEqual([]);
  });

  it("delivers the held mail in the background and lets shutdown wait for it", async () => {
    deliver();
    await h.background.idle();
    expect(h.sent).toEqual(h.mail);
  });
});

describe("auth mail failures", () => {
  it("are logged, never surfaced to the request", async () => {
    const h = await harness({}, { mailProvider: () => Promise.reject(new Error("provider down")) });
    try {
      const res = await call(h, "POST", "/api/auth/sign-up/email", {
        body: { email: "unlucky@example.com", password: PASSWORD, name: "Unlucky" },
      });
      expect(res.status).toBe(200);
      expect(h.mail).toHaveLength(1);
      await h.background.idle();
      expect(h.sent).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
