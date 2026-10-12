import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  sealKid,
  openSealed,
  sha256Hex,
  viewingKeySealContext,
} from "../../src/platform/crypto.ts";
import { AppError } from "../../src/platform/errors.ts";
import { RESERVED_TAGS } from "../../src/services/tags.ts";
import {
  type Harness,
  createHarness,
  createMerchant,
  createUser,
  testAddress,
  testUfvk,
} from "../support/harness.ts";

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

describe("tags service", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("claims a name that resolves to the merchant's current address", async () => {
    const merchant = await createMerchant(h);
    const tag = await h.services.tags.create(merchant.merchantId, "testnet", " Asharib.shade ");
    expect(tag).toMatchObject({
      name: "asharib",
      display: "asharib.shade",
      network: "testnet",
      address: merchant.addresses.testnet,
    });
    expect(await h.services.tags.resolve("asharib.shade")).toEqual({
      name: "asharib",
      network: "testnet",
      address: merchant.addresses.testnet,
    });
    const moved = testAddress("testnet");
    await h.db`update merchants set ua_testnet = ${moved} where id = ${merchant.merchantId}`;
    expect((await h.services.tags.resolve("asharib")).address).toBe(moved);
    expect((await h.services.tags.list(merchant.merchantId, null)).map((t) => t.name)).toEqual([
      "asharib",
    ]);
  });

  it("refuses bad, reserved and taken names", async () => {
    const merchant = await createMerchant(h);
    for (const name of ["", "-dash", "dash-", "under_score", "a".repeat(33), "dot.ted"]) {
      expect(
        (await rejects(h.services.tags.create(merchant.merchantId, "testnet", name))).code,
      ).toBe("BAD_TAG");
    }
    for (const name of ["www", "admin", "support", "zcash", "docs", "status"]) {
      expect(RESERVED_TAGS.has(name)).toBe(true);
      const err = await rejects(h.services.tags.create(merchant.merchantId, "testnet", name));
      expect(err).toMatchObject({
        code: "BAD_TAG",
        message: "That name is reserved. Pick another one.",
      });
    }
    await h.services.tags.create(merchant.merchantId, "testnet", "taken");
    const other = await createMerchant(h);
    expect(
      await rejects(h.services.tags.create(other.merchantId, "testnet", "TAKEN")),
    ).toMatchObject({
      status: 409,
      code: "TAG_TAKEN",
    });
  });

  it("limits each merchant to 5 names and needs an address", async () => {
    const merchant = await createMerchant(h);
    for (let i = 0; i < 5; i += 1)
      await h.services.tags.create(merchant.merchantId, "testnet", `shop${i}x`);
    expect(
      await rejects(h.services.tags.create(merchant.merchantId, "testnet", "shop6x")),
    ).toMatchObject({
      status: 409,
      code: "TAG_LIMIT",
    });
    const bare = await createUser(h);
    expect((await rejects(h.services.tags.create(bare.merchantId, "testnet", "bare"))).code).toBe(
      "NO_ADDRESS",
    );
  });

  it("404s unknown names", async () => {
    expect((await rejects(h.services.tags.resolve("nobody-here"))).status).toBe(404);
    expect((await rejects(h.services.tags.resolve("../etc"))).status).toBe(404);
  });
});

describe("keys service", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ SHADE_NETWORKS: "testnet,mainnet" });
  });
  afterAll(() => h.close());

  it("issues network-bound merchant keys shown once and stored as SHA-256", async () => {
    const merchant = await createMerchant(h);
    const test = await h.services.keys.issue(merchant.merchantId, {
      kind: "merchant",
      label: "server",
      network: "testnet",
    });
    const live = await h.services.keys.issue(merchant.merchantId, {
      kind: "merchant",
      label: "live",
      network: "mainnet",
    });
    expect(test.token).toMatch(/^sk_test_[A-Za-z0-9_-]{43}$/);
    expect(live.token).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    expect(test).toMatchObject({
      kind: "merchant",
      network: "testnet",
      prefix: `${test.token.slice(0, 12)}…`,
      last4: test.token.slice(-4),
      label: "server",
      jar_id: null,
      last_used_at: null,
      revoked_at: null,
    });
    const [row] = await h.db<{
      key_hash: string;
    }>`select key_hash from api_keys where id = ${test.id}`;
    expect(row?.key_hash).toBe(sha256Hex(test.token));
    const listed = await h.services.keys.list(merchant.merchantId, null);
    expect(listed.map((k) => k.id).sort()).toEqual([test.id, live.id].sort());
    expect(JSON.stringify(listed)).not.toContain(test.token);
    expect((await h.services.keys.list(merchant.merchantId, "mainnet")).map((k) => k.id)).toEqual([
      live.id,
    ]);
    await h.services.idle();
    expect(h.mail.at(-1)?.text).not.toContain(live.token);
  });

  it("binds agent keys to an open jar and its network", async () => {
    const merchant = await createMerchant(h, { networks: ["testnet", "mainnet"] });
    const jar = await h.services.jars.create(merchant.merchantId, "mainnet", {
      cap_zec: "1",
      label: "agent",
    });
    const agent = await h.services.keys.issue(merchant.merchantId, {
      kind: "agent",
      label: "",
      jar_id: jar.id,
    });
    expect(agent).toMatchObject({
      kind: "agent",
      network: "mainnet",
      jar_id: jar.id,
      label: "agent",
    });
    expect(agent.token).toMatch(/^ag_/);
    expect(
      (
        await rejects(
          h.services.keys.issue(merchant.merchantId, {
            kind: "agent",
            label: "x",
            jar_id: jar.id,
            network: "testnet",
          }),
        )
      ).code,
    ).toBe("INVALID_REQUEST");
    expect(
      (await rejects(h.services.keys.issue(merchant.merchantId, { kind: "agent", label: "x" })))
        .code,
    ).toBe("INVALID_REQUEST");
    const stranger = await createMerchant(h);
    expect(
      (
        await rejects(
          h.services.keys.issue(stranger.merchantId, { kind: "agent", label: "x", jar_id: jar.id }),
        )
      ).status,
    ).toBe(404);
    await h.services.jars.kill({ merchantId: merchant.merchantId, network: null }, jar.id);
    expect(
      (
        await rejects(
          h.services.keys.issue(merchant.merchantId, { kind: "agent", label: "x", jar_id: jar.id }),
        )
      ).code,
    ).toBe("JAR_CLOSED");
  });

  it("resolves live keys to principals and refuses revoked or expired ones", async () => {
    const merchant = await createMerchant(h);
    const key = await h.services.keys.issue(merchant.merchantId, {
      kind: "merchant",
      label: "p",
      network: "testnet",
    });
    expect(await h.services.keys.resolvePrincipal(key.token)).toEqual({
      kind: "merchant",
      keyId: key.id,
      merchantId: merchant.merchantId,
      network: "testnet",
      jarId: null,
    });
    const [used] = await h.db<{
      last_used_at: Date | null;
    }>`select last_used_at from api_keys where id = ${key.id}`;
    expect(used?.last_used_at).toBeInstanceOf(Date);
    await h.services.keys.resolvePrincipal(key.token);
    const [same] = await h.db<{
      last_used_at: Date | null;
    }>`select last_used_at from api_keys where id = ${key.id}`;
    expect(same?.last_used_at?.getTime()).toBe(used?.last_used_at?.getTime());

    expect(await h.services.keys.resolvePrincipal(`sk_test_${"A".repeat(43)}`)).toBeNull();
    const revoked = await h.services.keys.revoke(merchant.merchantId, key.id);
    expect(revoked.revoked_at).not.toBeNull();
    expect(await h.services.keys.resolvePrincipal(key.token)).toBeNull();

    const expiring = await h.services.keys.issue(merchant.merchantId, {
      kind: "merchant",
      label: "e",
      network: "testnet",
    });
    await h.db`update api_keys set expires_at = ${new Date(h.clock().getTime() - 1000)} where id = ${expiring.id}`;
    expect(await h.services.keys.resolvePrincipal(expiring.token)).toBeNull();
    expect((await rejects(h.services.keys.revoke(merchant.merchantId, "key_nope"))).status).toBe(
      404,
    );
  });

  it("refuses keys for networks this server does not enable", async () => {
    const testnetOnly = await createHarness();
    try {
      const merchant = await createMerchant(testnetOnly);
      const err = await rejects(
        testnetOnly.services.keys.issue(merchant.merchantId, {
          kind: "merchant",
          label: "x",
          network: "mainnet",
        }),
      );
      expect(err).toMatchObject({ status: 403, code: "NETWORK_DISABLED" });
    } finally {
      await testnetOnly.close();
    }
  });
});

describe("viewing keys service", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("seals the UFVK to the worker key, stores a fingerprint and uses the key's address", async () => {
    const merchant = await createMerchant(h);
    const ufvk = testUfvk("testnet");
    const status = await h.services.viewingKeys.upload(merchant.merchantId, "testnet", { ufvk });
    expect(status).toMatchObject({
      network: "testnet",
      fingerprint: sha256Hex(ufvk).slice(0, 16),
      key_address: await h.scanner.keyAddress(ufvk),
      use_key_address: true,
      scan: {
        state: "idle",
        cursor_height: null,
        tip_height: null,
        lag_blocks: null,
        last_error: null,
      },
    });
    const [row] = await h.db<{ sealed_key: string; seal_kid: string }>`
      select sealed_key, seal_kid from merchant_viewing_keys where id = ${status.id}`;
    expect(row?.sealed_key).not.toContain(ufvk);
    expect(row?.seal_kid).toBe(sealKid(h.config.sealPublicKey ?? new Uint8Array()));
    expect(
      openSealed(
        h.config.sealPrivateKeys,
        row?.sealed_key ?? "",
        viewingKeySealContext(merchant.merchantId, "testnet"),
      ),
    ).toBe(ufvk);
    const [merchantRow] = await h.db<{ ua_testnet: string }>`
      select ua_testnet from merchants where id = ${merchant.merchantId}`;
    expect(merchantRow?.ua_testnet).toBe(status.key_address);
    await h.services.idle();
    expect(h.mail.at(-1)?.subject).toBe("Hosted payment detection is on");
    expect(h.mail.at(-1)?.text).not.toContain(ufvk);
  });

  it("replaces the active key on re-upload and keeps scan progress for the same key", async () => {
    const merchant = await createMerchant(h);
    const ufvk = testUfvk("testnet");
    const first = await h.services.viewingKeys.upload(merchant.merchantId, "testnet", { ufvk });
    const cursorTime = new Date("2026-01-02T03:04:05.000Z");
    await h.db`update merchant_viewing_keys set cursor_height = 1200, cursor_hash = ${"9".repeat(64)}, cursor_time = ${cursorTime}, tip_height = 1210 where id = ${first.id}`;
    const second = await h.services.viewingKeys.upload(merchant.merchantId, "testnet", {
      ufvk,
      use_key_address: false,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.scan).toMatchObject({ cursor_height: 1200, tip_height: 1210, lag_blocks: 10 });
    // The whole cursor moves over, including the chain time it reached (the worker's window for
    // expired candidates reads it; without it every expired invoice would be re-checked).
    const progress = async (id: string) => {
      const [row] = await h.db<{
        cursor_height: number | null;
        cursor_hash: string | null;
        cursor_time: Date | null;
      }>`select cursor_height, cursor_hash, cursor_time from merchant_viewing_keys where id = ${id}`;
      return row;
    };
    expect(await progress(second.id)).toEqual({
      cursor_height: 1200,
      cursor_hash: "9".repeat(64),
      cursor_time: cursorTime,
    });
    const [old] = await h.db<{ sealed_key: string; revoked_at: Date | null }>`
      select sealed_key, revoked_at from merchant_viewing_keys where id = ${first.id}`;
    expect(old).toMatchObject({ sealed_key: "" });
    expect(old?.revoked_at).toBeInstanceOf(Date);
    const listed = await h.services.viewingKeys.list(merchant.merchantId);
    expect(listed.map((k) => k.id)).toEqual([second.id]);

    const other = await h.services.viewingKeys.upload(merchant.merchantId, "testnet", {
      ufvk: testUfvk("testnet"),
    });
    expect(other.scan.cursor_height).toBeNull();
    expect(await progress(other.id)).toEqual({
      cursor_height: null,
      cursor_hash: null,
      cursor_time: null,
    });
  });

  it("keeps scan progress when the same key is deleted and uploaded again, not across keys", async () => {
    const merchant = await createMerchant(h);
    const ufvk = testUfvk("testnet");
    const first = await h.services.viewingKeys.upload(merchant.merchantId, "testnet", { ufvk });
    const cursorTime = new Date("2026-01-02T03:04:05.000Z");
    await h.db`update merchant_viewing_keys set cursor_height = 1500, cursor_hash = ${"8".repeat(64)}, cursor_time = ${cursorTime} where id = ${first.id}`;
    const cursorOf = async (id: string) => {
      const [row] = await h.db<{ cursor_height: number | null; cursor_time: Date | null }>`
        select cursor_height, cursor_time from merchant_viewing_keys where id = ${id}`;
      return row;
    };

    // Delete, then the same key again (the key_unavailable advice): progress carries over.
    await h.services.viewingKeys.remove(merchant.merchantId, "testnet");
    const again = await h.services.viewingKeys.upload(merchant.merchantId, "testnet", { ufvk });
    expect(await cursorOf(again.id)).toEqual({ cursor_height: 1500, cursor_time: cursorTime });

    // Another key in between breaks the chain: the original key starts fresh afterwards.
    await h.services.viewingKeys.remove(merchant.merchantId, "testnet");
    await h.services.viewingKeys.upload(merchant.merchantId, "testnet", {
      ufvk: testUfvk("testnet"),
    });
    await h.services.viewingKeys.remove(merchant.merchantId, "testnet");
    const fresh = await h.services.viewingKeys.upload(merchant.merchantId, "testnet", { ufvk });
    expect(await cursorOf(fresh.id)).toEqual({ cursor_height: null, cursor_time: null });
  });

  it("rejects unusable keys without echoing them", async () => {
    const merchant = await createMerchant(h);
    for (const raw of [
      testAddress("testnet"),
      "abandon ".repeat(23) + "art",
      testUfvk("mainnet"),
      "uivktest1xyz",
    ]) {
      const err = await rejects(
        h.services.viewingKeys.upload(merchant.merchantId, "testnet", { ufvk: raw }),
      );
      expect(err).toMatchObject({ status: 400, code: "BAD_VIEWING_KEY" });
      expect(err.message).not.toContain(raw);
    }
  });

  it("deletes a key by wiping the envelope", async () => {
    const merchant = await createMerchant(h);
    const status = await h.services.viewingKeys.upload(merchant.merchantId, "testnet", {
      ufvk: testUfvk("testnet"),
    });
    await h.services.viewingKeys.remove(merchant.merchantId, "testnet");
    const [row] = await h.db<{ sealed_key: string; revoked_at: Date | null }>`
      select sealed_key, revoked_at from merchant_viewing_keys where id = ${status.id}`;
    expect(row?.sealed_key).toBe("");
    expect(row?.revoked_at).toBeInstanceOf(Date);
    expect(await h.services.viewingKeys.list(merchant.merchantId)).toEqual([]);
    expect(
      (await rejects(h.services.viewingKeys.remove(merchant.merchantId, "testnet"))).status,
    ).toBe(404);
  });

  it("is 409 HOSTED_DETECTION_DISABLED without a seal public key", async () => {
    const noSeal = await createHarness();
    try {
      noSeal.config.sealPublicKey = null;
      const merchant = await createMerchant(noSeal);
      const err = await rejects(
        noSeal.services.viewingKeys.upload(merchant.merchantId, "testnet", {
          ufvk: testUfvk("testnet"),
        }),
      );
      expect(err).toMatchObject({ status: 409, code: "HOSTED_DETECTION_DISABLED" });
      expect((await noSeal.services.config.appConfig()).features.hosted_detection).toBe(false);
    } finally {
      await noSeal.close();
    }
  });
});
