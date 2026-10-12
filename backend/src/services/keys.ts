/**
 * API keys: network-bound merchant keys (`sk_test_` / `sk_live_`) and jar-bound agent keys (`ag_`,
 * on their jar's network). Tokens carry 32 random bytes, are shown once and stored as SHA-256.
 */
import type { ApiKey, ApiKeyCreated, ApiKeyKind, Network } from "../contract/index.ts";
import { COPY } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { newId, randomToken, sha256Hex } from "../platform/crypto.ts";
import type { Db } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import type { Principal } from "../platform/http.ts";
import type { Logger } from "../platform/logger.ts";
import { formatZat, zatFromNumeric } from "../zcash/money.ts";
import {
  LABEL_MAX_CHARS,
  assertNetworkEnabled,
  hasControlChars,
  iso,
  isoOrNull,
  notFound,
} from "./common.ts";
import { requireMerchant } from "./merchants.ts";
import type { Notifier } from "./notifications.ts";

/** last_used_at is written at most once per minute per key. */
const LAST_USED_THROTTLE_MS = 60_000;
/** Revoked keys per list, newest first, after every live key (live keys are never cut). */
const REVOKED_LIST_LIMIT = 200;
const PREFIX_SECRET_CHARS = 4;

export interface KeyInput {
  kind: ApiKeyKind;
  label: string;
  jar_id?: string;
  network?: Network;
}

export interface KeyService {
  issue(merchantId: string, input: KeyInput): Promise<ApiKeyCreated>;
  list(merchantId: string, network: Network | null): Promise<ApiKey[]>;
  revoke(merchantId: string, keyId: string): Promise<ApiKey>;
  /** apiKeyAuth's resolver: a live key's principal, or null (revoked, expired, unknown). */
  resolvePrincipal(token: string): Promise<Principal | null>;
}

interface KeyRow {
  id: string;
  merchant_id: string;
  kind: ApiKeyKind;
  network: Network;
  prefix: string;
  last4: string;
  label: string;
  jar_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
}

const KEY_COLUMNS =
  "id, merchant_id, kind, network, prefix, last4, label, jar_id, created_at, last_used_at, revoked_at, expires_at";

function keyDto(row: KeyRow): ApiKey {
  return {
    id: row.id,
    kind: row.kind,
    network: row.network,
    prefix: row.prefix,
    last4: row.last4,
    label: row.label,
    jar_id: row.jar_id,
    created_at: iso(row.created_at),
    last_used_at: isoOrNull(row.last_used_at),
    revoked_at: isoOrNull(row.revoked_at),
  };
}

function stemFor(kind: ApiKeyKind, network: Network): string {
  if (kind === "agent") return "ag_";
  return network === "mainnet" ? "sk_live_" : "sk_test_";
}

export function createKeyService(deps: {
  db: Db;
  config: Config;
  logger: Logger;
  clock: () => Date;
  notifier: Notifier;
}): KeyService {
  const { db, config, logger, clock, notifier } = deps;

  return {
    async issue(merchantId, input) {
      const label = input.label.trim() || input.kind;
      if (label.length > LABEL_MAX_CHARS || hasControlChars(label)) {
        throw new AppError(
          400,
          "BAD_LABEL",
          `Give the key a short single-line label of at most ${LABEL_MAX_CHARS} characters.`,
        );
      }
      const merchant = await requireMerchant(db, merchantId);
      if (input.kind === "merchant" && input.jar_id !== undefined) {
        throw new AppError(400, "INVALID_REQUEST", "A merchant key does not belong to a jar.");
      }
      if (input.kind === "agent" && input.jar_id === undefined) {
        throw new AppError(400, "INVALID_REQUEST", "An agent key belongs to one jar: send jar_id.");
      }

      const created = await db.tx(async (sql) => {
        let network: Network;
        let jarId: string | null = null;
        if (input.kind === "agent") {
          // Lock order: jar row first, then api_keys.
          const [jar] = await sql<{
            id: string;
            network: Network;
            status: string;
            cap_zec: string;
            spent_zec: string;
          }>`
            select id, network, status, cap_zec, spent_zec from jars
            where id = ${input.jar_id} and merchant_id = ${merchantId}
            for update`;
          if (!jar) throw notFound("jar");
          if (input.network !== undefined && input.network !== jar.network) {
            throw new AppError(400, "INVALID_REQUEST", "An agent key takes its jar's network.");
          }
          if (jar.status !== "open") {
            throw new AppError(409, "JAR_CLOSED", COPY.jarClosed, {
              remaining_zec: formatZat(zatFromNumeric(jar.cap_zec) - zatFromNumeric(jar.spent_zec)),
            });
          }
          network = jar.network;
          jarId = jar.id;
        } else {
          network = input.network ?? merchant.network;
        }
        assertNetworkEnabled(config, network);

        const stem = stemFor(input.kind, network);
        const token = `${stem}${randomToken(32)}`;
        const [row] = await sql.query<KeyRow>(
          `insert into api_keys (id, merchant_id, kind, jar_id, prefix, key_hash, label, network,
             last4, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning ${KEY_COLUMNS}`,
          [
            newId("key"),
            merchantId,
            input.kind,
            jarId,
            `${token.slice(0, stem.length + PREFIX_SECRET_CHARS)}…`,
            sha256Hex(token),
            label,
            network,
            token.slice(-4),
            clock(),
          ],
        );
        if (!row) throw new Error("api key insert returned no row");
        return { row, token };
      });

      notifier.keyIssued(merchantId, { kind: input.kind, network: created.row.network, label });
      return { ...keyDto(created.row), token: created.token };
    },

    async list(merchantId, network) {
      // Every live key (so each can be revoked), then the newest revoked ones.
      const params: unknown[] = network === null ? [merchantId] : [merchantId, network];
      const scope = network === null ? "merchant_id = $1" : "merchant_id = $1 and network = $2";
      const rows = await db.query<KeyRow>(
        `(select ${KEY_COLUMNS} from api_keys where ${scope} and revoked_at is null)
         union all
         (select ${KEY_COLUMNS} from api_keys where ${scope} and revoked_at is not null
          order by created_at desc, id desc limit ${REVOKED_LIST_LIMIT})
         order by created_at desc, id desc`,
        params,
      );
      // Live first, newest first within each group.
      return rows
        .sort((a, b) => Number(a.revoked_at !== null) - Number(b.revoked_at !== null))
        .map(keyDto);
    },

    async revoke(merchantId, keyId) {
      const [row] = await db.query<KeyRow>(
        `update api_keys set revoked_at = coalesce(revoked_at, $3)
         where id = $1 and merchant_id = $2
         returning ${KEY_COLUMNS}`,
        [keyId, merchantId, clock()],
      );
      if (!row) throw notFound("API key");
      return keyDto(row);
    },

    async resolvePrincipal(token) {
      const [row] = await db.query<KeyRow>(
        `select ${KEY_COLUMNS} from api_keys where key_hash = $1`,
        [sha256Hex(token)],
      );
      if (!row) return null;
      const now = clock();
      if (row.revoked_at !== null) return null;
      if (row.expires_at !== null && row.expires_at.getTime() <= now.getTime()) return null;

      if (
        row.last_used_at === null ||
        now.getTime() - row.last_used_at.getTime() >= LAST_USED_THROTTLE_MS
      ) {
        try {
          await db`
            update api_keys set last_used_at = ${now}
            where id = ${row.id} and (last_used_at is null or last_used_at < ${new Date(now.getTime() - LAST_USED_THROTTLE_MS)})`;
        } catch (err) {
          logger.warn({ err, key_id: row.id }, "api key last_used_at update failed");
        }
      }

      if (row.kind === "agent") {
        if (row.jar_id === null) return null;
        return {
          kind: "agent",
          keyId: row.id,
          merchantId: row.merchant_id,
          network: row.network,
          jarId: row.jar_id,
        };
      }
      return {
        kind: "merchant",
        keyId: row.id,
        merchantId: row.merchant_id,
        network: row.network,
        jarId: null,
      };
    },
  };
}
