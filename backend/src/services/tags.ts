/** Tags: `name.shade` resolves to the merchant's receive address on the tag's network. */
import type { Network, Tag, TagResolution } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { newId } from "../platform/crypto.ts";
import type { Db } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import { assertNetworkEnabled, iso, notFound } from "./common.ts";
import { requireMerchant, requireReceiveAddress, shieldedAddressOrNull } from "./merchants.ts";

export const MAX_TAGS_PER_MERCHANT = 5;
const TAG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SUFFIX = ".shade";

/**
 * Names that would impersonate Shade, its infrastructure or the protocol (ported from the legacy
 * list and extended). Tags are never released, so a reserved name can never be claimed later.
 */
export const RESERVED_TAGS: ReadonlySet<string> = new Set([
  "www",
  "api",
  "pay",
  "app",
  "desk",
  "shade",
  "mail",
  "admin",
  "support",
  "help",
  "security",
  "billing",
  "zcash",
  "root",
  "status",
  "docs",
  "abuse",
  "postmaster",
  "hostmaster",
  "webmaster",
  "noreply",
  "no-reply",
  "login",
  "signup",
  "auth",
  "account",
  "accounts",
  "dashboard",
  "settings",
  "view",
  "grant",
  "grants",
  "invoice",
  "invoices",
  "jar",
  "jars",
  "webhook",
  "webhooks",
  "tag",
  "tags",
  "v1",
  "test",
  "testnet",
  "mainnet",
  "official",
  "team",
  "staff",
  "system",
  "info",
  "contact",
  "legal",
  "privacy",
  "terms",
  "blog",
  "news",
  "dev",
  "developer",
  "developers",
  "static",
  "assets",
  "cdn",
  "email",
  "zec",
  "wallet",
  "faucet",
  "explorer",
  "orchard",
  "sapling",
  "ironwood",
]);

/** Lowercase name without the `.shade` suffix, or null when it is not a valid tag name. */
export function parseTagName(raw: string): string | null {
  let name = raw.trim().toLowerCase();
  if (name.endsWith(SUFFIX)) name = name.slice(0, -SUFFIX.length);
  return TAG_PATTERN.test(name) ? name : null;
}

interface TagRow {
  id: string;
  name: string;
  network: Network;
  created_at: Date;
  address: string | null;
}

export interface TagService {
  create(merchantId: string, network: Network, name: string): Promise<Tag>;
  list(merchantId: string, network: Network | null): Promise<Tag[]>;
  /** Public resolution; unknown names and tags without a live address are 404. */
  resolve(name: string): Promise<TagResolution>;
}

export function createTagService(deps: { db: Db; config: Config; clock: () => Date }): TagService {
  const { db, config, clock } = deps;

  /** The merchant column is read as stored, so it goes through the same check as invoicing. */
  const liveAddress = (row: TagRow): string | null =>
    shieldedAddressOrNull(row.address, row.network);

  const tagDto = (row: TagRow): Tag => ({
    id: row.id,
    name: row.name,
    display: `${row.name}${SUFFIX}`,
    network: row.network,
    address: liveAddress(row) ?? "",
    created_at: iso(row.created_at),
  });

  /** The address a tag resolves to is the merchant's current one for the tag's network. */
  const TAG_SELECT = `select t.id, t.name, t.network, t.created_at,
      case t.network when 'mainnet' then m.ua_mainnet else m.ua_testnet end as address
    from tags t join merchants m on m.id = t.merchant_id`;

  return {
    async create(merchantId, network, raw) {
      assertNetworkEnabled(config, network);
      const name = parseTagName(raw);
      if (name === null) {
        throw new AppError(
          400,
          "BAD_TAG",
          "Use a short lowercase name, like asharib: letters, numbers and hyphens, up to 32 characters.",
        );
      }
      if (RESERVED_TAGS.has(name)) {
        throw new AppError(400, "BAD_TAG", "That name is reserved. Pick another one.");
      }
      return db.tx(async (sql) => {
        // The merchant row lock serialises concurrent claims against the per-merchant limit.
        const merchant = await requireMerchant(sql, merchantId, { forUpdate: true });
        requireReceiveAddress(merchant, network);
        const [count] = await sql<{ n: number }>`
          select count(*)::int as n from tags where merchant_id = ${merchantId}`;
        if ((count?.n ?? 0) >= MAX_TAGS_PER_MERCHANT) {
          throw new AppError(
            409,
            "TAG_LIMIT",
            `You can claim up to ${MAX_TAGS_PER_MERCHANT} names.`,
          );
        }
        const id = newId("tag");
        const inserted = await sql`
          insert into tags (id, merchant_id, name, network, created_at)
          values (${id}, ${merchantId}, ${name}, ${network}, ${clock()})
          on conflict (name) do nothing
          returning id`;
        if (inserted.length === 0) {
          throw new AppError(409, "TAG_TAKEN", "That name is already taken.");
        }
        const [row] = await sql.query<TagRow>(`${TAG_SELECT} where t.id = $1`, [id]);
        if (!row) throw new Error("tag insert returned no row");
        return tagDto(row);
      });
    },

    async list(merchantId, network) {
      const rows =
        network === null
          ? await db.query<TagRow>(
              `${TAG_SELECT} where t.merchant_id = $1 order by t.created_at desc, t.id desc`,
              [merchantId],
            )
          : await db.query<TagRow>(
              `${TAG_SELECT} where t.merchant_id = $1 and t.network = $2
               order by t.created_at desc, t.id desc`,
              [merchantId, network],
            );
      return rows.map(tagDto);
    },

    async resolve(raw) {
      const name = parseTagName(raw);
      if (name === null) throw notFound("name");
      const [row] = await db.query<TagRow>(`${TAG_SELECT} where t.name = $1`, [name]);
      const address = row ? liveAddress(row) : null;
      if (!row || address === null || !config.networks.includes(row.network)) {
        throw notFound("name");
      }
      return { name: row.name, network: row.network, address };
    },
  };
}
