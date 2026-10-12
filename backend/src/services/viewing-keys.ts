/**
 * Hosted detection keys: the merchant uploads a UFVK; the API validates it, derives the key's
 * shielded address, seals it to the worker's X25519 key (this tier cannot open it) and stores only
 * the envelope, a fingerprint and the address. Deleting wipes the envelope.
 */
import type { Network, ScanErrorCode, ScanState, ViewingKeyStatus } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { fingerprint, newId, sealKid, sealTo, viewingKeySealContext } from "../platform/crypto.ts";
import type { Db } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import { parseMerchantAddress, parseUfvk } from "../zcash/address.ts";
import type { Scanner } from "../zcash/scanner.ts";
import { assertNetworkEnabled, iso, isoOrNull, notFound } from "./common.ts";
import type { ConfigService } from "./config.ts";
import { addressColumn, requireMerchant, sameOrchardReceiver } from "./merchants.ts";
import type { Notifier } from "./notifications.ts";

export interface ViewingKeyInput {
  ufvk: string;
  use_key_address?: boolean;
}

export interface ViewingKeyService {
  /** Upsert: replaces the network's active key (keeping the scan cursor when it is the same key). */
  upload(merchantId: string, network: Network, input: ViewingKeyInput): Promise<ViewingKeyStatus>;
  remove(merchantId: string, network: Network): Promise<void>;
  list(merchantId: string): Promise<ViewingKeyStatus[]>;
}

interface ViewingKeyRow {
  id: string;
  network: Network;
  fingerprint: string;
  key_address: string;
  use_key_address: boolean;
  cursor_height: number | null;
  cursor_hash: string | null;
  tip_height: number | null;
  last_scan_at: Date | null;
  last_error: string | null;
  scan_locked_until: Date | null;
  created_at: Date;
}

/** What a re-upload of the same key carries over from the row it replaces. */
type ScanProgress = Pick<
  ViewingKeyRow,
  "fingerprint" | "cursor_height" | "cursor_hash" | "tip_height" | "last_scan_at" | "created_at"
> & { cursor_time: Date | null; scan_from: Date | null };

const VIEWING_KEY_COLUMNS =
  "id, network, fingerprint, key_address, use_key_address, cursor_height, cursor_hash, tip_height, " +
  "last_scan_at, last_error, scan_locked_until, created_at";

/**
 * Every ScanErrorCode the worker may store (a record, so a code added to the contract must be listed
 * here). Anything else reads as scan_failed.
 */
const SCAN_ERRORS: Record<ScanErrorCode, true> = {
  chain_unavailable: true,
  scan_failed: true,
  key_unavailable: true,
  scanner_unsupported_upgrade: true,
  ambiguous_match: true,
  txid_in_use: true,
};

function scanError(code: string | null): ScanErrorCode | null {
  if (code === null) return null;
  return Object.hasOwn(SCAN_ERRORS, code) ? (code as ScanErrorCode) : "scan_failed";
}

export function createViewingKeyService(deps: {
  db: Db;
  config: Config;
  scanner: Scanner;
  clock: () => Date;
  appConfig: ConfigService;
  notifier: Notifier;
}): ViewingKeyService {
  const { db, config, scanner, clock, appConfig, notifier } = deps;

  const statusDto = (row: ViewingKeyRow, hosted: boolean): ViewingKeyStatus => {
    const now = clock();
    const lastError = scanError(row.last_error);
    let state: ScanState = "idle";
    if (!hosted || !config.networks.includes(row.network)) state = "disabled";
    else if (row.scan_locked_until !== null && row.scan_locked_until.getTime() > now.getTime()) {
      state = "scanning";
    } else if (lastError !== null) state = "error";
    return {
      id: row.id,
      network: row.network,
      fingerprint: row.fingerprint,
      key_address: row.key_address,
      use_key_address: row.use_key_address,
      created_at: iso(row.created_at),
      scan: {
        state,
        cursor_height: row.cursor_height,
        tip_height: row.tip_height,
        lag_blocks:
          row.tip_height !== null && row.cursor_height !== null
            ? Math.max(0, row.tip_height - row.cursor_height)
            : null,
        last_scan_at: isoOrNull(row.last_scan_at),
        last_error: lastError,
      },
    };
  };

  return {
    async upload(merchantId, network, input) {
      assertNetworkEnabled(config, network);
      const sealPublicKey = config.sealPublicKey;
      if (sealPublicKey === null || !(await appConfig.hostedDetection())) {
        throw new AppError(
          409,
          "HOSTED_DETECTION_DISABLED",
          "Hosted detection is not available on this Shade server. Run the scanner on your own machine instead.",
        );
      }
      const parsed = parseUfvk(input.ufvk, network);
      if (!parsed.ok) throw new AppError(400, "BAD_VIEWING_KEY", parsed.message);
      const unreadable = () =>
        new AppError(
          400,
          "BAD_VIEWING_KEY",
          "Shade could not read an address from that viewing key. Export it again from your wallet.",
        );
      let derived: string;
      try {
        derived = await scanner.keyAddress(parsed.ufvk);
      } catch {
        throw unreadable();
      }
      const address = parseMerchantAddress(derived, network);
      if (!address.ok) throw unreadable();
      const keyAddress = address.address;
      const useKeyAddress = input.use_key_address ?? true;
      const keyFingerprint = fingerprint(parsed.ufvk);
      const sealed = sealTo(sealPublicKey, parsed.ufvk, viewingKeySealContext(merchantId, network));

      const row = await db.tx(async (sql) => {
        const now = clock();
        const merchant = await requireMerchant(sql, merchantId, { forUpdate: true });
        // Keeping the current address is accepted only when it is this key's own address (or none
        // is on file): Shade cannot tell another address of the same account from an address of
        // another wallet, and this response has no room for a warning (saving an address later
        // warns instead). The same key again keeps whatever address it already had, which is the
        // way to another address of this wallet that the message offers. This is the only place
        // VIEWING_KEY_ADDRESS_MISMATCH is raised.
        const [active] = await sql<{ fingerprint: string }>`
          select fingerprint from merchant_viewing_keys
          where merchant_id = ${merchantId} and network = ${network} and revoked_at is null`;
        const current = merchant.addresses[network];
        if (
          !useKeyAddress &&
          active?.fingerprint !== keyFingerprint &&
          current !== null &&
          !sameOrchardReceiver(keyAddress, current)
        ) {
          throw new AppError(
            422,
            "VIEWING_KEY_ADDRESS_MISMATCH",
            "Shade can't confirm that your receive address belongs to this viewing key, so it might not detect payments to it. Turn on “Use this key's address” for this upload. To use another address of the same wallet, upload the key again afterwards with it turned off, then save that address under Receive addresses.",
          );
        }
        const [previous] = await sql<ScanProgress>`
          update merchant_viewing_keys
          set revoked_at = ${now}, sealed_key = '', scan_lease = null, scan_locked_until = null,
              updated_at = ${now}
          where merchant_id = ${merchantId} and network = ${network} and revoked_at is null
          returning fingerprint, cursor_height, cursor_hash, cursor_time, tip_height, last_scan_at,
            scan_from, created_at`;
        // The same key again keeps its scan progress (cursor height, hash and chain time move
        // together), whether it replaces the active row or follows a delete (the key_unavailable
        // advice); a key that never completed a scan keeps the time of its first upload
        // (scan_from). Starting from this upload instead would drop invoices that expired while the
        // key could not be scanned. Only the newest row of this merchant and network counts, so
        // another key uploaded in between starts fresh; a key deleted more than 90 days ago starts
        // fresh too.
        const [latest] =
          previous !== undefined
            ? [previous]
            : await sql<ScanProgress>`
                select fingerprint, cursor_height, cursor_hash, cursor_time, tip_height, last_scan_at,
                  scan_from, created_at
                from merchant_viewing_keys
                where merchant_id = ${merchantId} and network = ${network}
                  and revoked_at > ${new Date(now.getTime() - 90 * 86_400_000)}
                order by created_at desc, id desc
                limit 1`;
        const carry = latest?.fingerprint === keyFingerprint ? latest : null;
        const [inserted] = await sql.query<ViewingKeyRow>(
          `insert into merchant_viewing_keys
             (id, merchant_id, network, sealed_key, seal_kid, fingerprint, key_address,
              use_key_address, cursor_height, cursor_hash, cursor_time, tip_height, last_scan_at,
              scan_from, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
           returning ${VIEWING_KEY_COLUMNS}`,
          [
            newId("vk"),
            merchantId,
            network,
            sealed,
            sealKid(sealPublicKey),
            keyFingerprint,
            keyAddress,
            useKeyAddress,
            carry?.cursor_height ?? null,
            carry?.cursor_hash ?? null,
            carry?.cursor_time ?? null,
            carry?.tip_height ?? null,
            carry?.last_scan_at ?? null,
            carry !== null && carry.cursor_height === null
              ? (carry.scan_from ?? carry.created_at)
              : null,
            now,
          ],
        );
        if (!inserted) throw new Error("viewing key insert returned no row");
        if (useKeyAddress) {
          await sql.query(`update merchants set ${addressColumn(network)} = $1 where id = $2`, [
            keyAddress,
            merchantId,
          ]);
        }
        return inserted;
      });

      notifier.viewingKeyAdded(merchantId, {
        network,
        fingerprint: keyFingerprint,
        useKeyAddress,
      });
      return statusDto(row, true);
    },

    async remove(merchantId, network) {
      const now = clock();
      const removed = await db`
        update merchant_viewing_keys
        set revoked_at = ${now}, sealed_key = '', scan_lease = null, scan_locked_until = null,
            updated_at = ${now}
        where merchant_id = ${merchantId} and network = ${network} and revoked_at is null
        returning id`;
      if (removed.length === 0) throw notFound("viewing key for this network");
    },

    async list(merchantId) {
      const hosted = await appConfig.hostedDetection();
      const rows = await db.query<ViewingKeyRow>(
        `select ${VIEWING_KEY_COLUMNS} from merchant_viewing_keys
         where merchant_id = $1 and revoked_at is null
         order by network`,
        [merchantId],
      );
      return rows.map((row) => statusDto(row, hosted));
    },
  };
}
