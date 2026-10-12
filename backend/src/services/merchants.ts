import { type AddressSaved, COPY, type Me, type Network } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { newId } from "../platform/crypto.ts";
import type { Db, Sql } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import { orchardReceiverOf, parseMerchantAddress } from "../zcash/address.ts";
import { LABEL_MAX_CHARS, assertNetworkEnabled, hasControlChars, notFound } from "./common.ts";
import type { ConfigService } from "./config.ts";
import type { Notifier } from "./notifications.ts";

export interface MerchantRecord {
  id: string;
  userId: string;
  /** "" means no display name (payers then see no shop name). */
  displayName: string;
  network: Network;
  addresses: Record<Network, string | null>;
}

/** The signed-in desk user, as sessionAuth puts it on the request. */
export interface DeskUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

interface MerchantRow {
  id: string;
  user_id: string;
  display_name: string;
  network: Network;
  ua_testnet: string | null;
  ua_mainnet: string | null;
}

/** Fixed column per network (never built from input). */
const ADDRESS_COLUMN: Record<Network, "ua_testnet" | "ua_mainnet"> = {
  testnet: "ua_testnet",
  mainnet: "ua_mainnet",
};

const STRIPPED_NOTICE =
  "Shade removed the transparent receiver from this address, so payers can only pay it privately.";
/**
 * Shade can only compare an address with the key's own (default) address: another address of the
 * same wallet account has a different Orchard receiver yet is still detected, while an address of
 * another account is not. Without a real ownership check the mismatch is a warning, not an error.
 */
const UNCONFIRMED_NOTICE =
  "Shade can't confirm this address belongs to your viewing key. If it comes from a different wallet or account, Shade won't detect payments to it.";

function toRecord(row: MerchantRow): MerchantRecord {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    network: row.network,
    addresses: { testnet: row.ua_testnet, mainnet: row.ua_mainnet },
  };
}

/** Loads a merchant on any handle; `forUpdate` locks the row for per-merchant caps. */
export async function loadMerchant(
  sql: Sql,
  merchantId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<MerchantRecord | null> {
  const rows = await sql.query<MerchantRow>(
    `select id, user_id, display_name, network, ua_testnet, ua_mainnet from merchants where id = $1${
      opts.forUpdate ? " for update" : ""
    }`,
    [merchantId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function requireMerchant(
  sql: Sql,
  merchantId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<MerchantRecord> {
  const merchant = await loadMerchant(sql, merchantId, opts);
  if (!merchant) throw notFound("merchant");
  return merchant;
}

const RESAVE_ADDRESS =
  "Save your receive address again in Settings: Shade can't use the one on file for private payments.";

/**
 * The shielded-only form of a stored receive address (what saving it today would store), or null
 * when it cannot be paid privately. v0 stored any u/utest string unchecked and the SQL migrations
 * cannot re-encode one, so a stored address may still carry a transparent receiver (a ZIP-321 URI
 * with a memo refuses it) or lack an Orchard receiver. Every reader that builds a payment URI or
 * shows the address goes through this.
 */
export function shieldedAddressOrNull(stored: string | null, network: Network): string | null {
  if (stored === null) return null;
  const parsed = parseMerchantAddress(stored, network);
  return parsed.ok ? parsed.address : null;
}

/** The payable form of a stored address; 409 NO_ADDRESS (save it again) when it has none. */
function payableAddress(stored: string, network: Network): string {
  const address = shieldedAddressOrNull(stored, network);
  if (address === null) throw new AppError(409, "NO_ADDRESS", RESAVE_ADDRESS);
  return address;
}

/** The payable receive address on `network`; 409 NO_ADDRESS when none is usable. */
export function requireReceiveAddress(merchant: MerchantRecord, network: Network): string {
  const address = merchant.addresses[network];
  if (!address) {
    throw new AppError(409, "NO_ADDRESS", COPY.noAddress);
  }
  return payableAddress(address, network);
}

/** A Better Auth name becomes the shop name: trimmed, single line, at most 48 characters. */
function displayNameFrom(name: string): string {
  return [...name.trim()]
    .filter((ch) => !hasControlChars(ch))
    .join("")
    .slice(0, LABEL_MAX_CHARS);
}

/** True when both addresses carry the same Orchard receiver (the same diversified address). */
export function sameOrchardReceiver(a: string, b: string): boolean {
  const left = orchardReceiverOf(a);
  const right = orchardReceiverOf(b);
  return left !== null && right !== null && Buffer.from(left).equals(Buffer.from(right));
}

export interface MerchantService {
  /** Creates the merchant for a user if missing (`on conflict (user_id) do nothing`) and returns it. */
  ensure(user: { id: string; name: string }): Promise<MerchantRecord>;
  me(user: DeskUser, merchantId: string): Promise<Me>;
  updateProfile(user: DeskUser, merchantId: string, displayName: string): Promise<Me>;
  saveAddress(
    user: DeskUser,
    merchantId: string,
    network: Network,
    address: string,
  ): Promise<AddressSaved>;
  switchNetwork(user: DeskUser, merchantId: string, network: Network): Promise<Me>;
}

export function createMerchantService(deps: {
  db: Db;
  config: Config;
  clock: () => Date;
  appConfig: ConfigService;
  notifier: Notifier;
}): MerchantService {
  const { db, config, clock, appConfig, notifier } = deps;

  const byUser = async (userId: string): Promise<MerchantRecord | null> => {
    const rows = await db<MerchantRow>`
      select id, user_id, display_name, network, ua_testnet, ua_mainnet
      from merchants where user_id = ${userId}`;
    return rows[0] ? toRecord(rows[0]) : null;
  };

  const me = async (user: DeskUser, merchantId: string): Promise<Me> => {
    const merchant = await requireMerchant(db, merchantId);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        email_verified: user.emailVerified,
      },
      merchant: {
        id: merchant.id,
        display_name: merchant.displayName,
        network: merchant.network,
        // What invoices are created with: a v0 address shows shielded-only, or null to re-save.
        receive_addresses: {
          testnet: shieldedAddressOrNull(merchant.addresses.testnet, "testnet"),
          mainnet: shieldedAddressOrNull(merchant.addresses.mainnet, "mainnet"),
        },
      },
      networks_enabled: [...config.networks],
      hosted_detection: await appConfig.hostedDetection(),
    };
  };

  return {
    async ensure(user) {
      const existing = await byUser(user.id);
      if (existing) return existing;
      await db`
        insert into merchants (id, user_id, display_name, network, created_at)
        values (${newId("mer")}, ${user.id}, ${displayNameFrom(user.name)}, ${config.defaultNetwork}, ${clock()})
        on conflict (user_id) do nothing`;
      const created = await byUser(user.id);
      if (!created) throw new Error("merchant row is missing after insert");
      return created;
    },

    me,

    async updateProfile(user, merchantId, displayName) {
      const name = displayName.trim();
      if (name.length > LABEL_MAX_CHARS || hasControlChars(name)) {
        throw new AppError(
          400,
          "INVALID_REQUEST",
          `Use a single-line shop name of at most ${LABEL_MAX_CHARS} characters.`,
        );
      }
      await db`update merchants set display_name = ${name} where id = ${merchantId}`;
      return me(user, merchantId);
    },

    async saveAddress(user, merchantId, network, raw) {
      assertNetworkEnabled(config, network);
      const parsed = parseMerchantAddress(raw, network);
      if (!parsed.ok) throw new AppError(400, "BAD_ADDRESS", parsed.message);

      const { changed, unconfirmed } = await db.tx(async (sql) => {
        const merchant = await requireMerchant(sql, merchantId, { forUpdate: true });
        const [key] = await sql<{ key_address: string; use_key_address: boolean }>`
          select key_address, use_key_address from merchant_viewing_keys
          where merchant_id = ${merchantId} and network = ${network} and revoked_at is null`;
        // Both ways out work: re-uploading the active key is never refused, and without a key (or
        // with its address option off) any shielded address is saved, with UNCONFIRMED_NOTICE when
        // it is not the key's own.
        if (key?.use_key_address) {
          throw new AppError(
            409,
            "ADDRESS_MANAGED_BY_KEY",
            "Your viewing key provides this address. Upload the key again with “Use this key's address” turned off, or delete the key, to use a different address.",
          );
        }
        const result = {
          changed: merchant.addresses[network] !== parsed.address,
          unconfirmed: key !== undefined && !sameOrchardReceiver(key.key_address, parsed.address),
        };
        if (result.changed) {
          await sql.query(`update merchants set ${ADDRESS_COLUMN[network]} = $1 where id = $2`, [
            parsed.address,
            merchantId,
          ]);
        }
        return result;
      });

      if (changed) notifier.addressChanged(merchantId, network, parsed.strippedTransparent);
      const notices = [
        parsed.strippedTransparent ? STRIPPED_NOTICE : null,
        unconfirmed ? UNCONFIRMED_NOTICE : null,
      ].filter((notice) => notice !== null);
      return {
        me: await me(user, merchantId),
        address: parsed.address,
        notice: notices.length > 0 ? notices.join(" ") : null,
      };
    },

    async switchNetwork(user, merchantId, network) {
      assertNetworkEnabled(config, network);
      await db`update merchants set network = ${network} where id = ${merchantId}`;
      return me(user, merchantId);
    },
  };
}

/** The network column for a receive address (used when a viewing key sets the address). */
export function addressColumn(network: Network): "ua_testnet" | "ua_mainnet" {
  return ADDRESS_COLUMN[network];
}
