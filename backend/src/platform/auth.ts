import { randomBytes, randomUUID } from "node:crypto";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Logger } from "./logger.ts";
import type { Mailer } from "./mailer.ts";
import { createPgliteKysely } from "./pglite-dialect.ts";

export type Auth = ReturnType<typeof betterAuth>;

/** Runs work after the response without failing it; services/background.ts satisfies this. */
export interface AuthBackground {
  run(task: string, fn: () => Promise<unknown>): void;
}

export interface AuthDeps {
  config: Config;
  db: Db;
  mailer: Mailer;
  logger: Logger;
  /** Creates the merchant row (`insert … on conflict (user_id) do nothing`). Runs after the user commits. */
  onUserCreated: (user: { id: string; email: string; name: string }) => Promise<void>;
  /**
   * Where auth mail and Better Auth's deferred work run, so shutdown can drain them with its
   * `idle()`. Without it the work is still detached from the response, only untracked.
   */
  background?: AuthBackground;
}

/** The only request header Better Auth reads the client IP from; http.ts sets it per request. */
export const CLIENT_IP_HEADER = "x-shade-client-ip";

const TOKEN_TTL_SEC = 3600;

/** Better Auth stores `user.name` as unbounded text; the desk shows a 48-character shop name. */
const USER_NAME_MAX_CHARS = 128;

/**
 * Refuses a user name that is not text or is longer than USER_NAME_MAX_CHARS code points, and
 * any profile image (Shade never shows one). `fields` may be partial, as on an update: a field
 * that is absent or undefined is not checked, and `image: null` (clearing it) is allowed.
 */
function assertUserFields(fields: Record<string, unknown>): void {
  const { name, image } = fields;
  if (name !== undefined && (typeof name !== "string" || [...name].length > USER_NAME_MAX_CHARS)) {
    throw new APIError("BAD_REQUEST", {
      message: `Use a name of at most ${USER_NAME_MAX_CHARS} characters.`,
    });
  }
  if (image !== undefined && image !== null) {
    throw new APIError("BAD_REQUEST", { message: "Shade does not store profile images." });
  }
}

function database(db: Db) {
  if (db.pool) return db.pool;
  if (db.pglite) {
    // PGlite is one connection shared with app SQL, so Better Auth runs without transactions there.
    return { db: createPgliteKysely(db.pglite), type: "postgres" as const, transaction: false };
  }
  throw new Error("Db has neither a Postgres pool nor a PGlite instance");
}

function verificationMail(config: Config, token: string): { subject: string; text: string } {
  const url = new URL("/api/auth/verify-email", config.appOrigin);
  url.searchParams.set("token", token);
  // Verifying signs nobody in, so `verified=1` lets the SPA say "confirmed, now sign in" when
  // /desk sends the visitor to the sign-in page. A failed link also gets `error=…`, checked first.
  url.searchParams.set("callbackURL", `${config.appOrigin}/desk?verified=1`);
  return {
    subject: "Confirm your email for Shade",
    text: [
      "Confirm this email address to finish setting up Shade:",
      "",
      url.toString(),
      "",
      "The link expires in one hour. If you did not sign up for Shade, ignore this email.",
    ].join("\n"),
  };
}

function resetPasswordMail(config: Config, token: string): { subject: string; text: string } {
  const url = new URL("/reset-password", config.appOrigin);
  url.searchParams.set("token", token);
  return {
    subject: "Reset your Shade password",
    text: [
      "Use this link to choose a new Shade password:",
      "",
      url.toString(),
      "",
      "The link expires in one hour. If you did not ask for this, ignore this email; your password stays the same.",
    ].join("\n"),
  };
}

function unconfirmedAccountMail(config: Config, token: string): { subject: string; text: string } {
  const url = new URL("/reset-password", config.appOrigin);
  url.searchParams.set("token", token);
  return {
    subject: "Finish setting up Shade",
    text: [
      "Someone, maybe you, tried to create a Shade account with this email address. An account for it was started earlier but its email was never confirmed, so nobody can sign in to it.",
      "",
      "If you want this account, choose its password with this link. That also confirms your email:",
      "",
      url.toString(),
      "",
      "The link expires in one hour. If you did not try to sign up for Shade, ignore this email.",
    ].join("\n"),
  };
}

/**
 * Better Auth 1.7.7 for the desk (agents.md §4.6): email + password only, database-backed sessions with
 * no cookie cache, database rate limits keyed by the IP http.ts computed, and links that always
 * point at APP_ORIGIN (never at a caller-supplied callback).
 */
export function createAuth(deps: AuthDeps): Auth {
  const { config, mailer } = deps;
  const log = deps.logger.child({ component: "auth" });
  const production = config.env === "production";
  const background: AuthBackground = deps.background ?? {
    run: (task, fn) => {
      void fn().catch((err: unknown) => log.error({ err, task }, "auth background task failed"));
    },
  };

  // Only some requests send mail (reset: known emails; sign-up: new emails; verification resend:
  // unverified accounts). If the response waited for the provider, its latency would say whether
  // the account exists, so mail always runs after the response. Failures are logged, not thrown,
  // for the same reason; the user can ask for the email again.
  const deliver = (
    event: string,
    to: string,
    mail: { subject: string; text: string },
  ): Promise<void> => {
    background.run(`auth.mail.${event}`, async () => {
      try {
        await mailer.send({ to, ...mail });
      } catch (err) {
        log.error({ err, event }, "auth email was not sent");
      }
    });
    return Promise.resolve();
  };

  /**
   * Someone signed up with an email whose account was never confirmed. Whoever started that
   * account chose its password without proving they own the mailbox; if the password survived,
   * it would start working the moment the real owner confirmed the email (a pre-registered
   * account takeover). So the parked password, any session and the name go, and the mailbox gets a link to
   * choose a password, which also confirms the email (onPasswordReset). A sign-up for a
   * confirmed account changes nothing.
   *
   * Plain SQL on purpose: Better Auth calls this inside its sign-up transaction and backgrounds
   * it, so its own adapter here could still be bound to that (by then finished) transaction.
   */
  const reclaimUnconfirmed = async (userId: string): Promise<void> => {
    const token = randomBytes(24).toString("base64url");
    const email = await deps.db.tx(async (sql) => {
      const [user] = await sql<{ email: string }>`
        select email from "user" where id = ${userId} and not "emailVerified" for update`;
      if (!user) return null;
      await sql`delete from "account" where "userId" = ${userId} and "providerId" = 'credential'`;
      await sql`delete from "session" where "userId" = ${userId}`;
      // The name was chosen without the mailbox too, and payers see it as the shop name.
      await sql`update "user" set name = '', "updatedAt" = now() where id = ${userId}`;
      await sql`update merchants set display_name = '' where user_id = ${userId}`;
      // The row Better Auth's /request-password-reset writes; /reset-password consumes it.
      await sql`insert into "verification" (id, identifier, value, "expiresAt")
        values (${randomUUID()}, ${`reset-password:${token}`}, ${userId},
                ${new Date(Date.now() + TOKEN_TTL_SEC * 1000)})`;
      return user.email;
    });
    if (email !== null)
      await deliver("unconfirmed_signup", email, unconfirmedAccountMail(config, token));
  };

  const options: BetterAuthOptions = {
    appName: "Shade",
    baseURL: config.appOrigin,
    basePath: "/api/auth",
    secret: config.authSecret,
    database: database(deps.db),
    trustedOrigins: [config.appOrigin, ...config.devOrigins],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: config.requireEmailVerification,
      autoSignIn: false,
      minPasswordLength: config.passwordMinLength,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: TOKEN_TTL_SEC,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, token }) =>
        deliver("reset_password", user.email, resetPasswordMail(config, token)),
      // Only reachable from a link mailed to the address, so it proves the mailbox: this is how
      // a reclaimed (or merely unconfirmed) account gets confirmed with a password its owner chose.
      // It must not throw: Better Auth revokes the other sessions only after this returns, and the
      // password has already changed. Left unconfirmed, the owner can ask for another link.
      onPasswordReset: async ({ user }) => {
        try {
          await deps.db`update "user" set "emailVerified" = true, "updatedAt" = now()
            where id = ${user.id} and not "emailVerified"`;
        } catch (err) {
          log.error({ err, user_id: user.id }, "email was not confirmed after a password reset");
        }
      },
      // Better Auth answers with its generic success either way (autoSignIn: false) and runs
      // this in the background, so neither the response nor its timing says the email exists.
      // Without required verification an unconfirmed account is a normal account: left alone.
      onExistingUserSignUp: ({ user }) => {
        if (config.requireEmailVerification && !user.emailVerified) {
          background.run("auth.reclaim_unconfirmed", () => reclaimUnconfirmed(user.id));
        }
        return Promise.resolve();
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // A verification link proves the mailbox, not the password: signing its clicker in would
      // hand a session for an account whose password someone else may have chosen, and would let
      // a link for another account replace the session of the browser it is opened in (login
      // CSRF). The link only confirms the email; the user then signs in with their password.
      autoSignInAfterVerification: false,
      expiresIn: TOKEN_TTL_SEC,
      sendVerificationEmail: ({ user, token }) =>
        deliver("verify_email", user.email, verificationMail(config, token)),
    },
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: 7 * 86_400,
      updateAge: 86_400,
      freshAge: 900,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 5 },
        "/request-password-reset": { window: 3600, max: 3 },
        "/send-verification-email": { window: 3600, max: 3 },
      },
    },
    advanced: {
      useSecureCookies: production,
      cookiePrefix: "shade",
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // Without a handler Better Auth awaits every "background" promise (mail callbacks,
      // rate-limit row pruning) inside the request. It already attaches a logging catch.
      backgroundTasks: { handler: (task) => background.run("auth.background", () => task) },
    },
    telemetry: { enabled: false },
    hooks: {
      // Sign-up answers an existing email with a generic success before it would create a user,
      // so the database hook below alone would refuse a long name only for new emails: an
      // account-existence oracle. Checking the request first answers both alike.
      before: createAuthMiddleware(async (ctx) => {
        const body: unknown = ctx.body;
        if (ctx.path === "/sign-up/email" && typeof body === "object" && body !== null) {
          assertUserFields(body as Record<string, unknown>);
        }
      }),
    },
    logger: {
      level: "warn",
      log: (level, message, ...args) => {
        const err = args.find((arg) => arg instanceof Error);
        log[level]({ component: "better-auth", ...(err ? { err } : {}) }, message);
      },
    },
    databaseHooks: {
      user: {
        // Every path that writes a user row (sign-up, /update-user, auth.api calls). The HTTP body
        // limit already caps a name near 16K characters; these keep it to a sane length.
        create: {
          before: async (user) => {
            assertUserFields(user);
          },
          after: async (user) => {
            // Better Auth runs this after the user row commits; throwing here would abort sign-up
            // half way (user without credential), so failures are logged for the merchant
            // service to repair lazily.
            try {
              await deps.onUserCreated({ id: user.id, email: user.email, name: user.name });
            } catch (err) {
              log.error({ err, user_id: user.id }, "merchant creation hook failed");
            }
          },
        },
        update: {
          // Receives only the fields being changed (e.g. { emailVerified } on verification).
          before: async (user) => {
            assertUserFields(user);
          },
        },
      },
    },
  };
  return betterAuth(options);
}
