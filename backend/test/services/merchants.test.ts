import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/platform/errors.ts";
import type { DeskUser } from "../../src/services/merchants.ts";
import { decodeUnified, encodeUnified } from "../../src/zcash/address.ts";
import { createLedgerScanner } from "../../src/zcash/scanner.ts";
import {
  type Harness,
  createHarness,
  createUser,
  testAddress,
  testUfvk,
} from "../support/harness.ts";
import { hex, loadVectors } from "../zcash/fixtures.ts";

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

describe("merchants service", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ SHADE_NETWORKS: "testnet,mainnet" });
  });
  afterAll(() => h.close());

  const deskUser = async (name = "Shop"): Promise<{ user: DeskUser; merchantId: string }> => {
    const created = await createUser(h, { name });
    return {
      user: { id: created.userId, email: created.email, name, emailVerified: false },
      merchantId: created.merchantId,
    };
  };

  it("creates the merchant once per user (the sign-up hook and lazy ensure agree)", async () => {
    const { user, merchantId } = await deskUser("  Corner\u0007 Cafe  ");
    const again = await h.services.merchants.ensure({ id: user.id, name: "ignored" });
    expect(again.id).toBe(merchantId);
    expect(again.displayName).toBe("Corner Cafe");
    expect(again.network).toBe("testnet");
    const [count] = await h.db<{ n: number }>`
      select count(*)::int as n from merchants where user_id = ${user.id}`;
    expect(count?.n).toBe(1);
  });

  it("repairs a user whose merchant row is missing", async () => {
    const { user, merchantId } = await deskUser();
    await h.db`delete from merchants where id = ${merchantId}`;
    const repaired = await h.services.merchants.ensure({ id: user.id, name: user.name });
    expect(repaired.id).not.toBe(merchantId);
    expect(repaired.userId).toBe(user.id);
  });

  it("returns Me with the enabled networks and hosted detection", async () => {
    const { user, merchantId } = await deskUser("Me Shop");
    expect(await h.services.merchants.me(user, merchantId)).toEqual({
      user: { id: user.id, email: user.email, name: "Me Shop", email_verified: false },
      merchant: {
        id: merchantId,
        display_name: "Me Shop",
        network: "testnet",
        receive_addresses: { testnet: null, mainnet: null },
      },
      networks_enabled: ["testnet", "mainnet"],
      hosted_detection: true,
    });
  });

  it("updates the display name (at most 48 characters, one line)", async () => {
    const { user, merchantId } = await deskUser();
    const me = await h.services.merchants.updateProfile(user, merchantId, "  New Name ");
    expect(me.merchant.display_name).toBe("New Name");
    expect(
      (await h.services.merchants.updateProfile(user, merchantId, "")).merchant.display_name,
    ).toBe("");
    expect(
      (await rejects(h.services.merchants.updateProfile(user, merchantId, "x".repeat(49)))).code,
    ).toBe("INVALID_REQUEST");
  });

  it("saves a receive address, strips transparent receivers and emails the owner", async () => {
    const { user, merchantId } = await deskUser();
    const mailed = h.mail.length;
    const raw = testAddress("testnet", { transparent: true, sapling: true });
    const saved = await h.services.merchants.saveAddress(user, merchantId, "testnet", raw);
    expect(saved.notice).toMatch(/transparent/);
    const items = decodeUnified(saved.address).items.map((item) => item.typecode);
    expect(items).toEqual([0x02, 0x03]);
    expect(saved.me.merchant.receive_addresses.testnet).toBe(saved.address);
    await h.services.idle();
    expect(h.mail).toHaveLength(mailed + 1);
    expect(h.mail[mailed]).toMatchObject({
      to: user.email,
      subject: "Your Shade receive address changed",
    });
    expect(h.mail[mailed]?.text).not.toContain(saved.address);

    const unchanged = await h.services.merchants.saveAddress(
      user,
      merchantId,
      "testnet",
      saved.address,
    );
    expect(unchanged.notice).toBeNull();
    await h.services.idle();
    expect(h.mail).toHaveLength(mailed + 1);
  });

  it("rejects bad addresses with plain messages", async () => {
    const { user, merchantId } = await deskUser();
    for (const raw of [
      "t1abc",
      testAddress("mainnet"),
      "abandon ".repeat(11) + "about",
      testUfvk("testnet"),
    ]) {
      const err = await rejects(h.services.merchants.saveAddress(user, merchantId, "testnet", raw));
      expect(err).toMatchObject({ status: 400, code: "BAD_ADDRESS" });
      expect(err.message).not.toContain(raw);
    }
  });

  it("guards the address while a viewing key provides it", async () => {
    const { user, merchantId } = await deskUser();
    const ufvk = testUfvk("testnet");
    const status = await h.services.viewingKeys.upload(merchantId, "testnet", { ufvk });
    const managed = await rejects(
      h.services.merchants.saveAddress(user, merchantId, "testnet", testAddress("testnet")),
    );
    // The message names both ways out, and each of them works (below, and in the next test).
    expect(managed).toMatchObject({
      status: 409,
      code: "ADDRESS_MANAGED_BY_KEY",
      message:
        "Your viewing key provides this address. Upload the key again with “Use this key's address” turned off, or delete the key, to use a different address.",
    });

    await h.services.viewingKeys.upload(merchantId, "testnet", { ufvk, use_key_address: false });
    const same = await h.services.merchants.saveAddress(
      user,
      merchantId,
      "testnet",
      status.key_address,
    );
    expect(same).toMatchObject({ address: status.key_address, notice: null });

    // Shade cannot tell another address of the key's account from another wallet's: it warns.
    const other = testAddress("testnet", { transparent: true });
    const unconfirmed = await h.services.merchants.saveAddress(user, merchantId, "testnet", other);
    expect(unconfirmed.me.merchant.receive_addresses.testnet).toBe(unconfirmed.address);
    expect(unconfirmed.notice).toMatch(/^Shade removed the transparent receiver/);
    expect(unconfirmed.notice).toMatch(/can't confirm this address belongs to your viewing key/);
    // Re-saving the current address always succeeds.
    const again = await h.services.merchants.saveAddress(
      user,
      merchantId,
      "testnet",
      unconfirmed.address,
    );
    expect(again.notice).toMatch(/can't confirm/);
  });

  it("saves any address without a warning once the key that provided it is deleted", async () => {
    const { user, merchantId } = await deskUser();
    await h.services.viewingKeys.upload(merchantId, "testnet", { ufvk: testUfvk("testnet") });
    await h.services.viewingKeys.remove(merchantId, "testnet");
    const other = testAddress("testnet");
    const saved = await h.services.merchants.saveAddress(user, merchantId, "testnet", other);
    expect(saved).toMatchObject({ address: other, notice: null });
    expect(saved.me.merchant.receive_addresses.testnet).toBe(other);
  });

  it("accepts a diversified address of the key's account with a warning (ZIP-316 vectors)", async () => {
    // Account 13 of the zcash-test-vectors seed: its UFVK and its addresses at indices 0..2.
    const key = loadVectors("unified_full_viewing_keys.json").find((row) => row.account === 13);
    const ufvk = String(key?.unified_fvk);
    const addresses = loadVectors("unified_address.json").filter(
      (row) => row.account === 13 && row.root_seed === key?.root_seed && row.orchard_raw_addr,
    );
    const at = (index: number) => {
      const row = addresses.find((candidate) => candidate.diversifier_index === index);
      if (!row) throw new Error(`no vector for diversifier index ${index}`);
      return row;
    };
    // The key's address is its default (index 0) Orchard-only address, as the scanner derives it.
    const keyAddress = encodeUnified("address", "mainnet", [
      { typecode: 0x03, data: hex(String(at(0).orchard_raw_addr)) },
    ]);
    const real = createLedgerScanner({ urls: () => [] });
    if (await real.available()) expect(await real.keyAddress(ufvk)).toBe(keyAddress);
    h.scanner.setKeyAddress(ufvk, keyAddress);

    const { user, merchantId } = await deskUser();
    const status = await h.services.viewingKeys.upload(merchantId, "mainnet", {
      ufvk,
      use_key_address: false,
    });
    expect(status.key_address).toBe(keyAddress);

    const diversified = String(at(1).unified_addr);
    const saved = await h.services.merchants.saveAddress(user, merchantId, "mainnet", diversified);
    expect(saved.address).toBe(diversified);
    expect(saved.me.merchant.receive_addresses.mainnet).toBe(diversified);
    expect(saved.notice).toMatch(/can't confirm this address belongs to your viewing key/);

    const own = await h.services.merchants.saveAddress(
      user,
      merchantId,
      "mainnet",
      String(at(0).unified_addr),
    );
    expect(own.notice).toBeNull();
  });

  it("switches networks only to enabled ones", async () => {
    const { user, merchantId } = await deskUser();
    expect(
      (await h.services.merchants.switchNetwork(user, merchantId, "mainnet")).merchant.network,
    ).toBe("mainnet");
    const testnetOnly = await createHarness();
    try {
      const other = await createUser(testnetOnly);
      const err = await rejects(
        testnetOnly.services.merchants.switchNetwork(
          { id: other.userId, email: other.email, name: "x", emailVerified: true },
          other.merchantId,
          "mainnet",
        ),
      );
      expect(err).toMatchObject({ status: 403, code: "NETWORK_DISABLED" });
    } finally {
      await testnetOnly.close();
    }
  });
});
