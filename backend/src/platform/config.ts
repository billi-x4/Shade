import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NETWORKS, type Network } from "../contract/index.ts";
import { DEFAULT_EXPLORER_TX_URL } from "../zcash/explorer.ts";
import { DEFAULT_LIGHTWALLETD_URLS } from "../zcash/lightwalletd.ts";
import {
  decodeBase64Key,
  encodeBase64,
  generateSealKeyPair,
  randomToken,
  sealPublicKeyFromPrivate,
  timingSafeEqualStr,
} from "./crypto.ts";

export interface Config {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  appOrigin: string;
  /** Extra browser origins accepted besides appOrigin (127.0.0.1 ⇄ localhost twin, never in production). */
  devOrigins: string[];
  databaseUrl: string | null;
  databaseUrlUnpooled: string | null;
  /** PGlite data directory (development without DATABASE_URL); null means Postgres or in-memory. */
  pgliteDir: string | null;
  authSecret: string;
  requireEmailVerification: boolean;
  passwordMinLength: number;
  networks: Network[];
  defaultNetwork: Network;
  lightwalletd: Record<Network, string[]>;
  minConfirmations: Record<Network, number>;
  scanIntervalSec: number;
  encryptionKey: Uint8Array;
  sealPublicKey: Uint8Array | null;
  sealPrivateKeys: Uint8Array[];
  worker: "inline" | "off";
  webhookAllowPrivate: boolean;
  mail: { transport: "console" | "resend"; from: string; resendApiKey: string | null };
  /** Client-IP header set by the SPA host's proxy, trusted on requests with the edge secret. */
  trustProxy: "none" | "x-forwarded-for" | "x-real-ip" | "x-vercel-forwarded-for";
  /**
   * Client-IP header set by the backend host's own edge, for requests without the edge secret
   * (direct `/v1` callers) and when the proxy's header is missing. Only for a host whose edge
   * overwrites it on every public request (Railway: X-Real-IP); anywhere else a caller forges it.
   */
  trustProxyDirect: "none" | "x-forwarded-for" | "x-real-ip";
  edgeSharedSecret: string | null;
  explorerTxUrl: Record<Network, string | null>;
  logLevel: string;
}

/** Thrown by {@link loadConfig}; lists every problem at once and never includes a value. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const BACKEND_DIR = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_DATA_DIR = join(BACKEND_DIR, ".data");
const DEV_SECRETS_FILE = "dev-secrets.json";
const PASSWORD_MIN_LENGTH = 12;
const DEV_APP_ORIGIN = "http://localhost:5173";
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Empty or whitespace-only env values mean "unset" (a common deploy-UI mistake). */
const unset = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(unset, schema.optional());

const text = z.string().trim();

const boolFlag = text.toLowerCase().transform((value, ctx) => {
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  ctx.addIssue({ code: "custom", message: "must be true or false" });
  return z.NEVER;
});

const intIn = (min: number, max: number) =>
  text
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().min(min).max(max));

const origin = text.transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "must be an origin like https://shade-zcash.vercel.app",
    });
    return z.NEVER;
  }
  const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !bare) {
    ctx.addIssue({ code: "custom", message: "must be an origin (scheme, host, port; no path)" });
    return z.NEVER;
  }
  return url.origin;
});

const postgresUrl = text.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}, "must be a postgres:// connection string");

const key32 = text.transform((value, ctx) => {
  const key = decodeBase64Key(value);
  if (!key) {
    ctx.addIssue({ code: "custom", message: "must be 32 bytes, base64-encoded" });
    return z.NEVER;
  }
  return key;
});

const key32List = text.transform((value, ctx) => {
  const keys: Uint8Array[] = [];
  for (const item of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const key = decodeBase64Key(item);
    if (!key) {
      ctx.addIssue({ code: "custom", message: "every entry must be 32 bytes, base64-encoded" });
      return z.NEVER;
    }
    keys.push(key);
  }
  return keys;
});

const networkList = text.transform((value, ctx) => {
  const items = [...new Set(value.split(",").map((part) => part.trim().toLowerCase()))];
  const networks = items.filter((item): item is Network =>
    (NETWORKS as readonly string[]).includes(item),
  );
  if (networks.length !== items.length || networks.length === 0) {
    ctx.addIssue({ code: "custom", message: `must be a comma list of ${NETWORKS.join(", ")}` });
    return z.NEVER;
  }
  return networks;
});

const urlList = text.transform((value, ctx) => {
  const urls = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const valid = urls.every((item) => {
    try {
      const url = new URL(item);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  });
  if (!valid || urls.length === 0) {
    ctx.addIssue({ code: "custom", message: "must be a comma list of http(s) URLs" });
    return z.NEVER;
  }
  return urls;
});

const explorerTemplate = text.refine((value) => {
  if (!value.includes("{txid}")) return false;
  try {
    const url = new URL(value.replaceAll("{txid}", "0"));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, "must be an http(s) URL template containing {txid}");

const EnvSchema = z.object({
  NODE_ENV: optional(z.enum(["development", "test", "production"])),
  HOST: optional(text.min(1)),
  PORT: optional(intIn(1, 65535)),
  APP_ORIGIN: optional(origin),
  DATABASE_URL: optional(postgresUrl),
  DATABASE_URL_UNPOOLED: optional(postgresUrl),
  BETTER_AUTH_SECRET: optional(text.min(32, "must be at least 32 characters")),
  SHADE_ENCRYPTION_KEY: optional(key32),
  VIEWING_KEY_SEAL_PUBLIC_KEY: optional(key32),
  VIEWING_KEY_SEAL_PRIVATE_KEYS: optional(key32List),
  SHADE_NETWORKS: optional(networkList),
  LIGHTWALLETD_TESTNET_URL: optional(urlList),
  LIGHTWALLETD_MAINNET_URL: optional(urlList),
  SHADE_MIN_CONFIRMATIONS_TESTNET: optional(intIn(1, 100)),
  SHADE_MIN_CONFIRMATIONS_MAINNET: optional(intIn(1, 100)),
  SHADE_SCAN_INTERVAL_SEC: optional(intIn(1, 3600)),
  SHADE_WORKER: optional(z.enum(["inline", "off"])),
  SHADE_WEBHOOK_ALLOW_PRIVATE: optional(boolFlag),
  MAIL_TRANSPORT: optional(z.enum(["console", "resend"])),
  MAIL_FROM: optional(text.min(3).max(320)),
  RESEND_API_KEY: optional(text.min(1)),
  AUTH_REQUIRE_EMAIL_VERIFICATION: optional(boolFlag),
  TRUST_PROXY: optional(z.enum(["none", "x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for"])),
  TRUST_PROXY_DIRECT: optional(z.enum(["none", "x-forwarded-for", "x-real-ip"])),
  EDGE_SHARED_SECRET: optional(text.min(16, "must be at least 16 characters")),
  EXPLORER_TX_URL_TESTNET: optional(explorerTemplate),
  EXPLORER_TX_URL_MAINNET: optional(explorerTemplate),
  LOG_LEVEL: optional(z.enum(LOG_LEVELS)),
});

type ParsedEnv = z.infer<typeof EnvSchema>;

interface DevSecrets {
  authSecret: string;
  encryptionKey: Uint8Array;
  sealPublicKey: Uint8Array;
  sealPrivateKey: Uint8Array;
}

const DevSecretsFileSchema = z.object({
  betterAuthSecret: z.string().min(32).optional(),
  encryptionKey: z.string().optional(),
  sealPublicKey: z.string().optional(),
  sealPrivateKey: z.string().optional(),
});

function generateDevSecrets(): DevSecrets {
  const pair = generateSealKeyPair();
  return {
    authSecret: randomToken(32),
    encryptionKey: new Uint8Array(randomBytes(32)),
    sealPublicKey: pair.publicKey,
    sealPrivateKey: pair.privateKey,
  };
}

function serializeDevSecrets(secrets: DevSecrets): string {
  return `${JSON.stringify(
    {
      betterAuthSecret: secrets.authSecret,
      encryptionKey: encodeBase64(secrets.encryptionKey),
      sealPublicKey: encodeBase64(secrets.sealPublicKey),
      sealPrivateKey: encodeBase64(secrets.sealPrivateKey),
    },
    null,
    2,
  )}\n`;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/**
 * Reads `<dataDir>/dev-secrets.json`, creating it (mode 0600) or filling in missing entries.
 * Only ever called outside production.
 */
function loadDevSecretsFile(dataDir: string): DevSecrets {
  const path = join(dataDir, DEV_SECRETS_FILE);
  mkdirSync(dataDir, { recursive: true });
  const fresh = generateDevSecrets();
  try {
    writeFileSync(path, serializeDevSecrets(fresh), { mode: 0o600, flag: "wx" });
    return fresh;
  } catch (err) {
    if (!isErrnoCode(err, "EEXIST")) throw err;
  }

  let stored: z.infer<typeof DevSecretsFileSchema>;
  try {
    stored = DevSecretsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new ConfigError([`${path} is not valid; delete it to generate new development secrets`]);
  }
  const encryptionKey = stored.encryptionKey ? decodeBase64Key(stored.encryptionKey) : null;
  const sealPublicKey = stored.sealPublicKey ? decodeBase64Key(stored.sealPublicKey) : null;
  const sealPrivateKey = stored.sealPrivateKey ? decodeBase64Key(stored.sealPrivateKey) : null;
  const pairValid =
    sealPublicKey !== null &&
    sealPrivateKey !== null &&
    Buffer.from(sealPublicKeyFromPrivate(sealPrivateKey)).equals(Buffer.from(sealPublicKey));
  const secrets: DevSecrets = {
    authSecret: stored.betterAuthSecret ?? fresh.authSecret,
    encryptionKey: encryptionKey ?? fresh.encryptionKey,
    sealPublicKey: pairValid ? sealPublicKey : fresh.sealPublicKey,
    sealPrivateKey: pairValid ? sealPrivateKey : fresh.sealPrivateKey,
  };
  if (!stored.betterAuthSecret || !encryptionKey || !pairValid) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeDevSecrets(secrets), { mode: 0o600 });
    renameSync(tmp, path);
  }
  return secrets;
}

function loopbackTwin(appOrigin: string): string | null {
  const url = new URL(appOrigin);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  else if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  else return null;
  return url.origin;
}

/** Production validation guarantees these; outside production dev secrets fill them. */
function present<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new ConfigError([`${name}: required`]);
  return value;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`);
}

/** Only the console transport can use this sender; Resend rejects it. */
const CONSOLE_MAIL_FROM = "Shade <no-reply@localhost>";

/** Domains no mail provider will send from: loopback, RFC 2606/6761/6762 reserved names, intranets. */
const UNDELIVERABLE_SUFFIXES = [
  "localhost",
  "localdomain",
  "local",
  "test",
  "example",
  "invalid",
  "internal",
  "home.arpa",
  "example.com",
  "example.net",
  "example.org",
];

/**
 * True when MAIL_FROM (`addr@domain` or `Name <addr@domain>`) names a sender a provider could
 * verify: a public-looking DNS domain, not localhost, a reserved name or an IP literal.
 */
function isDeliverableSender(from: string): boolean {
  const address = (/<([^<>]*)>\s*$/.exec(from)?.[1] ?? from).trim();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) return false;
  const domain = address
    .slice(address.lastIndexOf("@") + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  if (domain.startsWith("[") || isIP(domain) !== 0) return false;
  if (!domain.includes(".") || domain.split(".").some((label) => label === "")) return false;
  return !UNDELIVERABLE_SUFFIXES.some(
    (suffix) => domain === suffix || domain.endsWith(`.${suffix}`),
  );
}

/**
 * Loads and validates configuration from `env`. Every problem is reported in one {@link ConfigError}.
 * Outside production, missing secrets come from `<dataDir>/dev-secrets.json` (development, or test
 * when `opts.dataDir` is given) or are generated per process (test). Production never reads that file.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { dataDir?: string } = {},
): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(formatZodIssues(parsed.error));
  const e: ParsedEnv = parsed.data;

  const nodeEnv = e.NODE_ENV ?? "development";
  const production = nodeEnv === "production";
  const issues: string[] = [];

  if (production) {
    if (!e.APP_ORIGIN) issues.push("APP_ORIGIN: required in production");
    if (!e.DATABASE_URL) issues.push("DATABASE_URL: required in production");
    if (!e.BETTER_AUTH_SECRET) issues.push("BETTER_AUTH_SECRET: required in production");
    if (!e.SHADE_ENCRYPTION_KEY) issues.push("SHADE_ENCRYPTION_KEY: required in production");
    if (e.SHADE_WEBHOOK_ALLOW_PRIVATE) {
      issues.push("SHADE_WEBHOOK_ALLOW_PRIVATE: must not be enabled in production");
    }
  }

  const requireEmailVerification = e.AUTH_REQUIRE_EMAIL_VERIFICATION ?? production;
  const mailTransport = e.MAIL_TRANSPORT ?? "console";
  if (production && requireEmailVerification && mailTransport === "console") {
    issues.push(
      "MAIL_TRANSPORT: console cannot deliver verification email in production; use resend or set AUTH_REQUIRE_EMAIL_VERIFICATION=false",
    );
  }
  if (mailTransport === "resend" && !e.RESEND_API_KEY) {
    issues.push("RESEND_API_KEY: required when MAIL_TRANSPORT=resend");
  }
  // Resend refuses senders outside a verified domain, and auth deliberately swallows mail errors
  // (no account-existence oracle), so a bad sender would fail every verification email silently.
  if (mailTransport === "resend") {
    if (!e.MAIL_FROM) {
      issues.push(
        "MAIL_FROM: required when MAIL_TRANSPORT=resend (a sender on a domain verified in Resend)",
      );
    } else if (!isDeliverableSender(e.MAIL_FROM)) {
      issues.push(
        "MAIL_FROM: must be an address on a domain verified in Resend; localhost, reserved and IP domains cannot send",
      );
    }
  }

  const sealPrivateKeys = e.VIEWING_KEY_SEAL_PRIVATE_KEYS ?? [];
  if (e.VIEWING_KEY_SEAL_PUBLIC_KEY && sealPrivateKeys.length > 0) {
    const publicKey = encodeBase64(e.VIEWING_KEY_SEAL_PUBLIC_KEY);
    const matches = sealPrivateKeys.some((privateKey) =>
      timingSafeEqualStr(encodeBase64(sealPublicKeyFromPrivate(privateKey)), publicKey),
    );
    if (!matches) {
      issues.push(
        "VIEWING_KEY_SEAL_PUBLIC_KEY: does not match any key in VIEWING_KEY_SEAL_PRIVATE_KEYS",
      );
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const sealKeysAbsent = !e.VIEWING_KEY_SEAL_PUBLIC_KEY && sealPrivateKeys.length === 0;
  const needsDevSecrets =
    !production && (!e.BETTER_AUTH_SECRET || !e.SHADE_ENCRYPTION_KEY || sealKeysAbsent);
  let devSecrets: DevSecrets | null = null;
  if (needsDevSecrets) {
    const dataDir = opts.dataDir ?? (nodeEnv === "development" ? DEFAULT_DATA_DIR : null);
    devSecrets = dataDir ? loadDevSecretsFile(dataDir) : generateDevSecrets();
  }

  const appOrigin = e.APP_ORIGIN ?? DEV_APP_ORIGIN;
  const twin = production ? null : loopbackTwin(appOrigin);
  const networks = e.SHADE_NETWORKS ?? ["testnet"];
  const databaseUrl = e.DATABASE_URL ?? null;
  const pgliteDataDir = opts.dataDir ?? DEFAULT_DATA_DIR;

  return {
    env: nodeEnv,
    host: e.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    port: e.PORT ?? 8787,
    appOrigin,
    devOrigins: twin ? [twin] : [],
    databaseUrl,
    databaseUrlUnpooled: e.DATABASE_URL_UNPOOLED ?? null,
    pgliteDir: !databaseUrl && nodeEnv === "development" ? join(pgliteDataDir, "pglite") : null,
    authSecret: present(e.BETTER_AUTH_SECRET ?? devSecrets?.authSecret, "BETTER_AUTH_SECRET"),
    requireEmailVerification,
    passwordMinLength: PASSWORD_MIN_LENGTH,
    networks,
    defaultNetwork: networks.includes("testnet")
      ? "testnet"
      : present(networks[0], "SHADE_NETWORKS"),
    lightwalletd: {
      testnet: e.LIGHTWALLETD_TESTNET_URL ?? [...DEFAULT_LIGHTWALLETD_URLS.testnet],
      mainnet: e.LIGHTWALLETD_MAINNET_URL ?? [...DEFAULT_LIGHTWALLETD_URLS.mainnet],
    },
    minConfirmations: {
      testnet: e.SHADE_MIN_CONFIRMATIONS_TESTNET ?? 1,
      mainnet: e.SHADE_MIN_CONFIRMATIONS_MAINNET ?? 10,
    },
    scanIntervalSec: e.SHADE_SCAN_INTERVAL_SEC ?? 20,
    encryptionKey: present(
      e.SHADE_ENCRYPTION_KEY ?? devSecrets?.encryptionKey,
      "SHADE_ENCRYPTION_KEY",
    ),
    sealPublicKey:
      e.VIEWING_KEY_SEAL_PUBLIC_KEY ??
      (sealKeysAbsent && devSecrets ? devSecrets.sealPublicKey : null),
    sealPrivateKeys:
      sealPrivateKeys.length > 0
        ? sealPrivateKeys
        : sealKeysAbsent && devSecrets
          ? [devSecrets.sealPrivateKey]
          : [],
    worker: e.SHADE_WORKER ?? (nodeEnv === "development" ? "inline" : "off"),
    webhookAllowPrivate: e.SHADE_WEBHOOK_ALLOW_PRIVATE ?? false,
    mail: {
      transport: mailTransport,
      from: e.MAIL_FROM ?? CONSOLE_MAIL_FROM,
      resendApiKey: e.RESEND_API_KEY ?? null,
    },
    trustProxy: e.TRUST_PROXY ?? "none",
    trustProxyDirect: e.TRUST_PROXY_DIRECT ?? "none",
    edgeSharedSecret: e.EDGE_SHARED_SECRET ?? null,
    explorerTxUrl: {
      testnet: e.EXPLORER_TX_URL_TESTNET ?? DEFAULT_EXPLORER_TX_URL.testnet,
      mainnet: e.EXPLORER_TX_URL_MAINNET ?? DEFAULT_EXPLORER_TX_URL.mainnet,
    },
    logLevel: e.LOG_LEVEL ?? "info",
  };
}

/**
 * Production settings that boot but are probably wrong for the reference deploy (the SPA host
 * rewrites /api and /v1 to the backend; agents.md §10). Warnings, not errors: a backend serving
 * clients directly correctly keeps TRUST_PROXY=none, and one reachable only through its proxy may
 * trust the proxy header without EDGE_SHARED_SECRET.
 */
export function configWarnings(config: Config): string[] {
  if (config.env !== "production") return [];
  if (config.trustProxy === "none" && config.trustProxyDirect !== "none") {
    return [
      `TRUST_PROXY=none: requests through the frontend rewrite are keyed on the proxy's address (${config.trustProxyDirect}), so its users share each per-IP rate limit (sign-in, sign-up, pay page). Set TRUST_PROXY with EDGE_SHARED_SECRET once the proxy's client-IP header is verified (agents.md §12.8).`,
    ];
  }
  if (config.trustProxy === "none") {
    return [
      "TRUST_PROXY=none: client IPs are socket addresses, so behind the frontend rewrite every user shares the proxy's per-IP rate limits (sign-in, sign-up, pay page). Set TRUST_PROXY with EDGE_SHARED_SECRET.",
    ];
  }
  if (config.edgeSharedSecret === null) {
    return [
      `TRUST_PROXY=${config.trustProxy} without EDGE_SHARED_SECRET: a client that reaches the backend directly can set ${config.trustProxy} and choose its own rate-limit bucket. Set EDGE_SHARED_SECRET unless only the proxy can reach the backend.`,
    ];
  }
  return [];
}
