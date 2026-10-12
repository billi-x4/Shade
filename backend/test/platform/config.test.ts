import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, configWarnings, loadConfig } from "../../src/platform/config.ts";
import {
  encodeBase64,
  generateSealKeyPair,
  sealPublicKeyFromPrivate,
} from "../../src/platform/crypto.ts";

const AUTH_SECRET = "s".repeat(40);
const ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");

const PRODUCTION = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://shade-zcash.vercel.app",
  DATABASE_URL: "postgres://user:pw@db.example.com:5432/shade",
  BETTER_AUTH_SECRET: AUTH_SECRET,
  SHADE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  MAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "re_test_key",
  MAIL_FROM: "Shade <no-reply@shade-zcash.vercel.app>",
};

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).issues;
  }
  throw new Error("expected loadConfig to throw");
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "shade-config-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("development defaults", () => {
  it("boots with no environment at all", () => {
    const config = loadConfig({}, { dataDir });
    expect(config).toMatchObject({
      env: "development",
      host: "127.0.0.1",
      port: 8787,
      appOrigin: "http://localhost:5173",
      devOrigins: ["http://127.0.0.1:5173"],
      databaseUrl: null,
      databaseUrlUnpooled: null,
      pgliteDir: join(dataDir, "pglite"),
      requireEmailVerification: false,
      passwordMinLength: 12,
      networks: ["testnet"],
      defaultNetwork: "testnet",
      lightwalletd: {
        testnet: ["https://testnet.zec.rocks:443", "https://zaino.testnet.unsafe.zec.rocks:443"],
        mainnet: ["https://zec.rocks:443", "https://zec-node.cakewallet.com:443"],
      },
      minConfirmations: { testnet: 1, mainnet: 10 },
      scanIntervalSec: 20,
      worker: "inline",
      webhookAllowPrivate: false,
      mail: { transport: "console", from: "Shade <no-reply@localhost>", resendApiKey: null },
      trustProxy: "none",
      trustProxyDirect: "none",
      edgeSharedSecret: null,
      logLevel: "info",
    });
    expect(config.explorerTxUrl.testnet).toContain("{txid}");
    expect(config.authSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.encryptionKey).toHaveLength(32);
    expect(config.sealPublicKey).toHaveLength(32);
    expect(config.sealPrivateKeys).toHaveLength(1);
    expect(sealPublicKeyFromPrivate(config.sealPrivateKeys[0]!)).toEqual(config.sealPublicKey);
  });

  it("persists generated secrets to dev-secrets.json and reuses them", () => {
    const first = loadConfig({}, { dataDir });
    const file = join(dataDir, "dev-secrets.json");
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual(
      ["betterAuthSecret", "encryptionKey", "sealPrivateKey", "sealPublicKey"].sort(),
    );
    const second = loadConfig({}, { dataDir });
    expect(second.authSecret).toBe(first.authSecret);
    expect(second.encryptionKey).toEqual(first.encryptionKey);
    expect(second.sealPublicKey).toEqual(first.sealPublicKey);
    expect(second.sealPrivateKeys).toEqual(first.sealPrivateKeys);
  });

  it("fills in missing entries of an older dev-secrets.json", () => {
    const file = join(dataDir, "dev-secrets.json");
    writeFileSync(
      file,
      JSON.stringify({ betterAuthSecret: AUTH_SECRET, encryptionKey: ENCRYPTION_KEY }),
    );
    const config = loadConfig({}, { dataDir });
    expect(config.authSecret).toBe(AUTH_SECRET);
    expect(encodeBase64(config.encryptionKey)).toBe(ENCRYPTION_KEY);
    expect(config.sealPublicKey).toHaveLength(32);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(stored.sealPublicKey).toBe(encodeBase64(config.sealPublicKey!));
  });

  it("refuses a corrupt dev-secrets.json", () => {
    writeFileSync(join(dataDir, "dev-secrets.json"), "{not json");
    expect(issuesOf(() => loadConfig({}, { dataDir }))[0]).toMatch(
      /dev-secrets\.json is not valid/,
    );
  });

  it("prefers explicit secrets over the dev file and does not touch it when all are set", () => {
    const pair = generateSealKeyPair();
    const config = loadConfig(
      {
        BETTER_AUTH_SECRET: AUTH_SECRET,
        SHADE_ENCRYPTION_KEY: ENCRYPTION_KEY,
        VIEWING_KEY_SEAL_PUBLIC_KEY: encodeBase64(pair.publicKey),
        VIEWING_KEY_SEAL_PRIVATE_KEYS: encodeBase64(pair.privateKey),
      },
      { dataDir },
    );
    expect(config.authSecret).toBe(AUTH_SECRET);
    expect(config.sealPublicKey).toEqual(pair.publicKey);
    expect(existsSync(join(dataDir, "dev-secrets.json"))).toBe(false);
  });

  it("uses Postgres instead of PGlite when DATABASE_URL is set", () => {
    const config = loadConfig({ DATABASE_URL: "postgresql://localhost/shade" }, { dataDir });
    expect(config.databaseUrl).toBe("postgresql://localhost/shade");
    expect(config.pgliteDir).toBeNull();
  });

  it("treats empty values as unset and parses lists and flags", () => {
    const config = loadConfig(
      {
        APP_ORIGIN: " ",
        PORT: "",
        SHADE_NETWORKS: "mainnet, testnet",
        SHADE_WEBHOOK_ALLOW_PRIVATE: "1",
        AUTH_REQUIRE_EMAIL_VERIFICATION: "true",
        LIGHTWALLETD_TESTNET_URL: "http://127.0.0.1:9067",
        SHADE_MIN_CONFIRMATIONS_TESTNET: "3",
        TRUST_PROXY: "x-real-ip",
        EXPLORER_TX_URL_MAINNET: "https://explorer.example/tx/{txid}",
      },
      { dataDir },
    );
    expect(config.appOrigin).toBe("http://localhost:5173");
    expect(config.port).toBe(8787);
    expect(config.networks).toEqual(["mainnet", "testnet"]);
    expect(config.defaultNetwork).toBe("testnet");
    expect(config.webhookAllowPrivate).toBe(true);
    expect(config.requireEmailVerification).toBe(true);
    expect(config.lightwalletd.testnet).toEqual(["http://127.0.0.1:9067"]);
    expect(config.minConfirmations.testnet).toBe(3);
    expect(config.trustProxy).toBe("x-real-ip");
    expect(config.explorerTxUrl.mainnet).toBe("https://explorer.example/tx/{txid}");
  });

  it("accepts the Vercel → Railway client-IP headers, and only edge-set ones as direct", () => {
    const config = loadConfig(
      { TRUST_PROXY: "x-vercel-forwarded-for", TRUST_PROXY_DIRECT: "x-real-ip" },
      { dataDir },
    );
    expect(config.trustProxy).toBe("x-vercel-forwarded-for");
    expect(config.trustProxyDirect).toBe("x-real-ip");
    // A header the backend's own edge never sets would let a direct caller choose its bucket.
    expect(() => loadConfig({ TRUST_PROXY_DIRECT: "x-vercel-forwarded-for" }, { dataDir })).toThrow(
      /TRUST_PROXY_DIRECT/,
    );
  });

  it("defaults to the only enabled network", () => {
    expect(loadConfig({ SHADE_NETWORKS: "mainnet" }, { dataDir }).defaultNetwork).toBe("mainnet");
  });

  it("normalizes origins and derives the loopback twin", () => {
    const config = loadConfig({ APP_ORIGIN: "http://127.0.0.1:5173/" }, { dataDir });
    expect(config.appOrigin).toBe("http://127.0.0.1:5173");
    expect(config.devOrigins).toEqual(["http://localhost:5173"]);
    expect(
      loadConfig({ APP_ORIGIN: "https://shade-zcash-dev.vercel.app" }, { dataDir }).devOrigins,
    ).toEqual([]);
  });
});

describe("test environment", () => {
  it("generates per-process secrets without writing files and keeps the worker off", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.env).toBe("test");
    expect(config.worker).toBe("off");
    expect(config.pgliteDir).toBeNull();
    expect(config.authSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.sealPublicKey).toHaveLength(32);
    expect(loadConfig({ NODE_ENV: "test" }).authSecret).not.toBe(config.authSecret);
  });
});

describe("validation", () => {
  it("aggregates every format problem without echoing values", () => {
    const secretLooking = "super-secret-value-that-must-not-leak";
    const issues = issuesOf(() =>
      loadConfig(
        {
          PORT: "eighty",
          APP_ORIGIN: "https://shade-zcash.vercel.app/app",
          SHADE_NETWORKS: "testnet,regtest",
          SHADE_ENCRYPTION_KEY: secretLooking,
          BETTER_AUTH_SECRET: "short",
          LOG_LEVEL: "loud",
          DATABASE_URL: "mysql://x",
          EXPLORER_TX_URL_TESTNET: "https://explorer.example/tx/",
        },
        { dataDir },
      ),
    );
    const fields = issues.map((issue) => issue.split(":")[0]);
    expect(fields).toEqual(
      expect.arrayContaining([
        "PORT",
        "APP_ORIGIN",
        "SHADE_NETWORKS",
        "SHADE_ENCRYPTION_KEY",
        "BETTER_AUTH_SECRET",
        "LOG_LEVEL",
        "DATABASE_URL",
        "EXPLORER_TX_URL_TESTNET",
      ]),
    );
    const message = issues.join("\n");
    expect(message).not.toContain(secretLooking);
    expect(message).not.toContain("mysql://x");
  });

  it("requires RESEND_API_KEY and a real MAIL_FROM for the resend transport", () => {
    expect(issuesOf(() => loadConfig({ MAIL_TRANSPORT: "resend" }, { dataDir }))).toEqual([
      "RESEND_API_KEY: required when MAIL_TRANSPORT=resend",
      "MAIL_FROM: required when MAIL_TRANSPORT=resend (a sender on a domain verified in Resend)",
    ]);
  });

  it("refuses MAIL_FROM senders that Resend can never send from", () => {
    for (const from of [
      "Shade <no-reply@localhost>", // the old .env.example value
      "no-reply@localhost",
      "Shade <no-reply@mail.localhost>",
      "Shade <no-reply@shade.local>",
      "no-reply@shade.test",
      "no-reply@shade.internal",
      "no-reply@example.com",
      "Shade <no-reply@[192.0.2.1]>",
      "no-reply@192.0.2.1",
      "no-reply@shade",
      "Shade <shade-zcash.vercel.app>",
      "Shade <no-reply@shade-zcash.vercel.app",
      "no reply@shade-zcash.vercel.app",
    ]) {
      const issues = issuesOf(() => loadConfig({ ...PRODUCTION, MAIL_FROM: from }, { dataDir }));
      expect(issues, from).toEqual([
        "MAIL_FROM: must be an address on a domain verified in Resend; localhost, reserved and IP domains cannot send",
      ]);
      expect(issues.join(" ")).not.toContain(from);
    }
    expect(issuesOf(() => loadConfig({ ...PRODUCTION, MAIL_FROM: "" }, { dataDir }))).toEqual([
      "MAIL_FROM: required when MAIL_TRANSPORT=resend (a sender on a domain verified in Resend)",
    ]);
  });

  it("accepts senders on public domains, bare or with a display name", () => {
    for (const from of [
      "Shade <no-reply@shade-zcash.vercel.app>",
      "no-reply@mail.shade-zcash.vercel.app",
      "Shade Desk <Hi@Shade-Zcash.Vercel.App.>",
      "onboarding@resend.dev",
    ]) {
      expect(loadConfig({ ...PRODUCTION, MAIL_FROM: from }, { dataDir }).mail.from).toBe(from);
    }
    // The console transport keeps its local placeholder sender.
    expect(loadConfig({}, { dataDir }).mail.from).toBe("Shade <no-reply@localhost>");
  });

  it("refuses a seal public key that matches none of the private keys", () => {
    const issues = issuesOf(() =>
      loadConfig(
        {
          VIEWING_KEY_SEAL_PUBLIC_KEY: encodeBase64(generateSealKeyPair().publicKey),
          VIEWING_KEY_SEAL_PRIVATE_KEYS: [
            encodeBase64(generateSealKeyPair().privateKey),
            encodeBase64(generateSealKeyPair().privateKey),
          ].join(","),
        },
        { dataDir },
      ),
    );
    expect(issues[0]).toMatch(/^VIEWING_KEY_SEAL_PUBLIC_KEY: does not match/);
  });

  it("accepts a rotation list containing the current key", () => {
    const old = generateSealKeyPair();
    const current = generateSealKeyPair();
    const config = loadConfig(
      {
        VIEWING_KEY_SEAL_PUBLIC_KEY: encodeBase64(current.publicKey),
        VIEWING_KEY_SEAL_PRIVATE_KEYS: `${encodeBase64(current.privateKey)}, ${encodeBase64(old.privateKey)}`,
      },
      { dataDir },
    );
    expect(config.sealPrivateKeys).toHaveLength(2);
  });
});

describe("production invariants", () => {
  it("boots with the required settings and production defaults", () => {
    const config = loadConfig(PRODUCTION, { dataDir });
    expect(config).toMatchObject({
      env: "production",
      host: "0.0.0.0",
      appOrigin: "https://shade-zcash.vercel.app",
      devOrigins: [],
      pgliteDir: null,
      requireEmailVerification: true,
      worker: "off",
      sealPublicKey: null,
      sealPrivateKeys: [],
    });
    expect(existsSync(join(dataDir, "dev-secrets.json"))).toBe(false);
  });

  it("requires origin, database, auth secret and encryption key together", () => {
    const issues = issuesOf(() =>
      loadConfig(
        {
          NODE_ENV: "production",
          MAIL_TRANSPORT: "resend",
          RESEND_API_KEY: "re_x",
          MAIL_FROM: "no-reply@shade-zcash.vercel.app",
        },
        { dataDir },
      ),
    );
    expect(issues).toEqual([
      "APP_ORIGIN: required in production",
      "DATABASE_URL: required in production",
      "BETTER_AUTH_SECRET: required in production",
      "SHADE_ENCRYPTION_KEY: required in production",
    ]);
    expect(existsSync(join(dataDir, "dev-secrets.json"))).toBe(false);
  });

  it("refuses console mail while email verification is required", () => {
    const issues = issuesOf(() =>
      loadConfig({ ...PRODUCTION, MAIL_TRANSPORT: "console", RESEND_API_KEY: "" }, { dataDir }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^MAIL_TRANSPORT: console cannot deliver/);
    const relaxed = loadConfig(
      { ...PRODUCTION, MAIL_TRANSPORT: "console", AUTH_REQUIRE_EMAIL_VERIFICATION: "false" },
      { dataDir },
    );
    expect(relaxed.requireEmailVerification).toBe(false);
  });

  it("refuses private webhook targets", () => {
    expect(
      issuesOf(() =>
        loadConfig({ ...PRODUCTION, SHADE_WEBHOOK_ALLOW_PRIVATE: "true" }, { dataDir }),
      ),
    ).toEqual(["SHADE_WEBHOOK_ALLOW_PRIVATE: must not be enabled in production"]);
  });

  it("enables hosted detection only with an explicit seal public key", () => {
    const pair = generateSealKeyPair();
    const config = loadConfig(
      { ...PRODUCTION, VIEWING_KEY_SEAL_PUBLIC_KEY: encodeBase64(pair.publicKey) },
      { dataDir },
    );
    expect(config.sealPublicKey).toEqual(pair.publicKey);
    expect(config.sealPrivateKeys).toEqual([]);
  });
});

describe("configWarnings", () => {
  const SECRET = "edge-secret-0123456789";

  it("warns in production when per-IP limits would collapse onto the proxy", () => {
    const warnings = configWarnings(loadConfig(PRODUCTION, { dataDir }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^TRUST_PROXY=none: /);
  });

  it("says proxied users share the proxy's bucket when only the host's own header is trusted", () => {
    const warnings = configWarnings(
      loadConfig({ ...PRODUCTION, TRUST_PROXY_DIRECT: "x-real-ip" }, { dataDir }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^TRUST_PROXY=none: requests through the frontend rewrite/);
    expect(warnings[0]).toContain("x-real-ip");
  });

  it("warns in production when the trusted proxy header can be forged", () => {
    for (const header of ["x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for"]) {
      const warnings = configWarnings(
        loadConfig({ ...PRODUCTION, TRUST_PROXY: header }, { dataDir }),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(new RegExp(`^TRUST_PROXY=${header} without EDGE_SHARED_SECRET`));
      expect(warnings[0]).not.toContain(SECRET);
    }
  });

  it("is quiet for the edge-authenticated proxy setup and outside production", () => {
    expect(
      configWarnings(
        loadConfig(
          { ...PRODUCTION, TRUST_PROXY: "x-forwarded-for", EDGE_SHARED_SECRET: SECRET },
          { dataDir },
        ),
      ),
    ).toEqual([]);
    expect(configWarnings(loadConfig({}, { dataDir }))).toEqual([]);
    expect(configWarnings(loadConfig({ TRUST_PROXY: "x-real-ip" }, { dataDir }))).toEqual([]);
  });
});
