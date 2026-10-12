import type { Network } from "../contract/index.ts";

/**
 * Block explorer transaction URL templates (`{txid}` = lowercase display-order txid). Verified
 * 2026-10-02: each returns the transaction (including v6 Ironwood ones) with its block height,
 * and 404 for an unknown txid.
 */
export const DEFAULT_EXPLORER_TX_URL: Record<Network, string | null> = {
  testnet: "https://testnet.zecblock.com/tx/{txid}",
  mainnet: "https://zecblock.com/tx/{txid}",
};
