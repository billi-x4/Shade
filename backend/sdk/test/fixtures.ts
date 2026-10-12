/** Wire bodies shaped exactly like backend/src/contract/types.ts DTOs (every field present). */

const UA =
  "utest1qx4h7jy8ngt8wxe8zvh4dfd9yuerkqk3p40gqerjgdrkq5eaf4xmmh8yzg8h6u5ul9t5ds3r9wgk3lxa6fg6r";

export const wireInvoice = {
  id: "inv_1",
  status: "open",
  verification: null,
  network: "testnet",
  amount_zec: "0.01",
  memo: "order_1042",
  chain_memo: "order_1042 (shade:7KQ2M9XA)",
  memo_hash: "sha256:3f0c6d1e9e8a4b9f5a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6",
  tag: "payroll",
  address: UA,
  zip321: `zcash:${UA}?amount=0.01&memo=b3JkZXJfMTA0MiAoc2hhZGU6N0tRMk05WEEp`,
  pay_url: "https://shade-zcash.vercel.app/pay/inv_1",
  txid: null,
  claimed_txid: null,
  created_height: 4_199_990,
  jar_id: null,
  created_at: "2026-10-02T12:00:00.000Z",
  expires_at: "2026-10-02T13:00:00.000Z",
  paid_at: null,
  detection: {
    state: "seen",
    txid: "a".repeat(64),
    pool: "ironwood",
    source: "shade_worker",
    block_height: 4_200_000,
    confirmations: 1,
    required_confirmations: 3,
    observed_at: "2026-10-02T12:05:00.000Z",
  },
} as const;

export const wireJarChargeInvoice = {
  ...wireInvoice,
  id: "inv_charge_1",
  status: "authorized",
  verification: "jar_ledger",
  amount_zec: "0.002",
  memo: "api:search",
  chain_memo: "api:search",
  tag: null,
  address: null,
  zip321: null,
  pay_url: null,
  created_height: null,
  jar_id: "jar_1",
  detection: null,
} as const;

export const wireJar = {
  id: "jar_1",
  label: "research-agent",
  status: "open",
  network: "testnet",
  cap_zec: "0.006",
  spent_zec: "0.002",
  remaining_zec: "0.004",
  address: UA,
  charge_count: 1,
  created_at: "2026-10-02T12:00:00.000Z",
  killed_at: null,
  note: "Stops new charges. Move leftover ZEC in your wallet.",
} as const;

export const wireChargeResult = {
  invoice_id: "inv_charge_1",
  jar_id: "jar_1",
  amount_zec: "0.002",
  memo_hash: "sha256:" + "b".repeat(64),
  remaining_zec: "0.004",
  status: "authorized",
  created_at: "2026-10-02T12:01:00.000Z",
} as const;

export const wireGrant = {
  id: "grt_1",
  scope: "payroll",
  network: "testnet",
  state: "revoked",
  created_at: "2026-10-02T12:00:00.000Z",
  expires_at: "2026-10-09T12:00:00.000Z",
  revoked_at: "2026-10-02T12:10:00.000Z",
  last_viewed_at: "2026-10-02T12:05:00.000Z",
  note: "Revoke stops new access from us. Delete the file on their machine too.",
} as const;

export const wireGrantCreated = {
  ...wireGrant,
  state: "active",
  revoked_at: null,
  last_viewed_at: null,
  token: "gv_" + "c".repeat(43),
  view_url: "https://shade-zcash.vercel.app/view#gv_" + "c".repeat(43),
} as const;

export const wireEndpointCreated = {
  id: "whe_1",
  url: "https://vendor.example/hooks/shade",
  network: "testnet",
  secret_hint: "Ab3d",
  created_at: "2026-10-02T12:00:00.000Z",
  disabled_at: null,
  disabled_reason: null,
  failure_count: 0,
  last_delivery_at: null,
  secret: "whsec_" + "d".repeat(39) + "Ab3d",
} as const;

export const wireTag = {
  id: "tag_1",
  name: "asharib",
  display: "asharib.shade",
  network: "testnet",
  address: UA,
  created_at: "2026-10-02T12:00:00.000Z",
} as const;

export const wireTagResolution = { name: "asharib", network: "testnet", address: UA } as const;

export const wireEvent = {
  id: "evt_1",
  type: "invoice.paid",
  created_at: "2026-10-02T12:06:00.000Z",
  network: "testnet",
  invoice_id: "inv_1",
  amount_zec: "0.01",
  memo_hash: wireInvoice.memo_hash,
  txid: "a".repeat(64),
  paid_at: "2026-10-02T12:06:00.000Z",
  verification: "ivk_scan",
} as const;
