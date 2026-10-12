import type { AppConfig, Invoice, Me, ViewingKeyStatus } from "@shade/contract";

/** Shared API fixtures for desk component tests. */
export const TESTNET_UA =
  "utest18z20cdj59zmjdl23hyxzrgn0hr7tlexmmkwav5nwzpgd27yk4y0dc7mwwn3c0cp960swz78h7fqsvxg72jvv4mehvvattdaemqljkrk4";

export function meFixture(
  overrides: Partial<Me["merchant"]> = {},
  networks?: Me["networks_enabled"],
): Me {
  return {
    user: { id: "usr_1", email: "shop@example.com", name: "", email_verified: true },
    merchant: {
      id: "mer_1",
      display_name: "Northline Coffee",
      network: "testnet",
      receive_addresses: { testnet: TESTNET_UA, mainnet: null },
      ...overrides,
    },
    networks_enabled: networks ?? ["testnet"],
    hosted_detection: false,
  };
}

export function configFixture(networks: AppConfig["networks"] = ["testnet"]): AppConfig {
  return {
    networks,
    default_network: networks[0] ?? "testnet",
    min_confirmations: { testnet: 1, mainnet: 3 },
    auth: { email_password: true, email_verification_required: false, password_min_length: 12 },
    features: { hosted_detection: false },
    explorer_tx_url: { testnet: null, mainnet: null },
  };
}

export function invoiceFixture(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv_1",
    status: "open",
    verification: null,
    network: "testnet",
    amount_zec: "0.01",
    memo: "Order 1042",
    chain_memo: "Order 1042 (shade:ABC123)",
    memo_hash: "sha256:00",
    tag: null,
    address: TESTNET_UA,
    zip321: `zcash:${TESTNET_UA}?amount=0.01`,
    pay_url: "http://localhost/pay/inv_1",
    txid: null,
    claimed_txid: null,
    created_height: 4_200_000,
    jar_id: null,
    created_at: "2026-10-02T10:00:00.000Z",
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    paid_at: null,
    detection: null,
    ...overrides,
  };
}

export function viewingKeyFixture(overrides: Partial<ViewingKeyStatus> = {}): ViewingKeyStatus {
  return {
    id: "vk_1",
    network: "testnet",
    fingerprint: "vk:1a2b3c4d",
    key_address: TESTNET_UA,
    use_key_address: true,
    created_at: "2026-10-02T09:00:00.000Z",
    scan: {
      state: "idle",
      cursor_height: 4_200_000,
      tip_height: 4_200_000,
      lag_blocks: 0,
      last_scan_at: "2026-10-02T10:00:00.000Z",
      last_error: null,
    },
    ...overrides,
  };
}
