import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook, WebhookVerificationError } from "../src/index.ts";
import type {
  VerifyWebhookOptions,
  WebhookHeaders,
  WebhookVerificationReason,
} from "../src/index.ts";
import { wireEvent } from "./fixtures.ts";
import { camelizeDeep } from "./helpers.ts";

const SECRET = "whsec_kN3vQ8xY2bL5mR7tW9zC1dF4gH6jK0pS";
const BODY = JSON.stringify(wireEvent);
const T = 1_790_000_000;
const NOW = () => T * 1000;

/** Independent reference: what the backend's platform/webhook-signing.ts sends (spec §6). */
function reference(secret: string, body: string, t: number) {
  const hmac = (data: string) =>
    createHmac("sha256", Buffer.from(secret, "utf8")).update(data, "utf8").digest("hex");
  return { legacy: `sha256=${hmac(body)}`, v2: `t=${t},v1=${hmac(`${t}.${body}`)}` };
}

async function rejection(promise: Promise<unknown>): Promise<WebhookVerificationReason> {
  const err = await promise.then(
    () => {
      throw new Error("expected verification to fail");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WebhookVerificationError);
  return (err as WebhookVerificationError).reason;
}

function verify(
  headers: WebhookHeaders,
  body: string | Uint8Array = BODY,
  opts: VerifyWebhookOptions = {},
) {
  return verifyWebhook(body, headers, SECRET, { now: NOW, ...opts });
}

describe("signWebhook", () => {
  it("matches HMAC-SHA256 keyed with the UTF-8 bytes of the full whsec_ secret", async () => {
    const ref = reference(SECRET, BODY, T);
    expect(await signWebhook(SECRET, BODY, T)).toStrictEqual({
      "X-Shade-Signature": ref.legacy,
      "X-Shade-Signature-V2": ref.v2,
    });
  });

  it("signs a Uint8Array body byte for byte", async () => {
    const bytes = new TextEncoder().encode(BODY);
    expect(await signWebhook(SECRET, bytes, T)).toStrictEqual(await signWebhook(SECRET, BODY, T));
  });

  it("rejects a bad timestamp or secret", async () => {
    await expect(signWebhook(SECRET, BODY, 1.5)).rejects.toThrow(TypeError);
    await expect(signWebhook("", BODY, T)).rejects.toThrow(TypeError);
  });
});

describe("verifyWebhook with X-Shade-Signature-V2", () => {
  it("accepts a valid delivery and returns the camelCase event", async () => {
    const ref = reference(SECRET, BODY, T);
    const headers = new Headers({
      "X-Shade-Signature": ref.legacy,
      "X-Shade-Signature-V2": ref.v2,
    });
    const event = await verify(headers);
    expect(event).toStrictEqual(camelizeDeep(wireEvent));
    expect(event).toMatchObject({
      type: "invoice.paid",
      invoiceId: "inv_1",
      amountZec: "0.01",
      verification: "ivk_scan",
    });
  });

  it("reads plain header objects case-insensitively (Node IncomingMessage.headers and others)", async () => {
    const { v2 } = reference(SECRET, BODY, T);
    await expect(verify({ "X-Shade-Signature-V2": v2 })).resolves.toMatchObject({ id: "evt_1" });
    await expect(verify({ "x-shade-signature-v2": v2 })).resolves.toMatchObject({ id: "evt_1" });
    await expect(
      verify({ "X-SHADE-SIGNATURE-V2": [v2], "content-type": "application/json" }),
    ).resolves.toMatchObject({
      id: "evt_1",
    });
  });

  it("accepts string, Uint8Array and Buffer bodies alike", async () => {
    const headers = { "x-shade-signature-v2": reference(SECRET, BODY, T).v2 };
    await expect(verify(headers, BODY)).resolves.toMatchObject({ id: "evt_1" });
    await expect(verify(headers, new TextEncoder().encode(BODY))).resolves.toMatchObject({
      id: "evt_1",
    });
    await expect(verify(headers, Buffer.from(BODY, "utf8"))).resolves.toMatchObject({
      id: "evt_1",
    });
  });

  it("enforces the timestamp tolerance in both directions (default 300 s)", async () => {
    const headers = { "x-shade-signature-v2": reference(SECRET, BODY, T).v2 };
    await expect(
      verify(headers, BODY, { now: () => (T + 300) * 1000 + 999 }),
    ).resolves.toBeDefined();
    await expect(verify(headers, BODY, { now: () => (T - 300) * 1000 })).resolves.toBeDefined();
    expect(await rejection(verify(headers, BODY, { now: () => (T + 301) * 1000 }))).toBe(
      "timestamp_out_of_tolerance",
    );
    expect(await rejection(verify(headers, BODY, { now: () => (T - 301) * 1000 }))).toBe(
      "timestamp_out_of_tolerance",
    );
    await expect(
      verify(headers, BODY, { now: () => (T + 301) * 1000, toleranceSec: 600 }),
    ).resolves.toBeDefined();
  });

  it("rejects a tampered body or timestamp", async () => {
    const { v2 } = reference(SECRET, BODY, T);
    const tamperedBody = BODY.replace('"0.01"', '"10.01"');
    expect(await rejection(verify({ "x-shade-signature-v2": v2 }, tamperedBody))).toBe(
      "signature_mismatch",
    );
    const retimed = v2.replace(`t=${T}`, `t=${T + 1}`);
    expect(await rejection(verify({ "x-shade-signature-v2": retimed }))).toBe("signature_mismatch");
  });

  it("rejects a delivery signed with another secret", async () => {
    const other = reference("whsec_someone_else", BODY, T);
    expect(await rejection(verify({ "x-shade-signature-v2": other.v2 }))).toBe(
      "signature_mismatch",
    );
    expect(
      await rejection(
        verify({ "x-shade-signature": other.legacy }, BODY, { allowLegacySignature: true }),
      ),
    ).toBe("signature_mismatch");
  });

  it("never falls back to the body-only signature when V2 is present but invalid", async () => {
    const ref = reference(SECRET, BODY, T);
    const stale = reference(SECRET, BODY, T - 3600).v2;
    expect(
      await rejection(
        verify({ "x-shade-signature-v2": "garbage", "x-shade-signature": ref.legacy }),
      ),
    ).toBe("malformed_signature");
    expect(
      await rejection(verify({ "x-shade-signature-v2": stale, "x-shade-signature": ref.legacy })),
    ).toBe("timestamp_out_of_tolerance");
  });

  it("signs over the header's t verbatim", async () => {
    const t = `0${T}`;
    const v1 = createHmac("sha256", SECRET).update(`${t}.${BODY}`).digest("hex");
    await expect(verify({ "x-shade-signature-v2": `t=${t},v1=${v1}` })).resolves.toBeDefined();
  });

  it("accepts any matching v1 entry and ignores unknown schemes", async () => {
    const { v2 } = reference(SECRET, BODY, T);
    const v1 = v2.split(",v1=")[1]!;
    const header = `t=${T}, v1=${"0".repeat(64)}, v1=${v1.toUpperCase()}, v9=future`;
    await expect(verify({ "x-shade-signature-v2": header })).resolves.toMatchObject({
      id: "evt_1",
    });
  });

  it.each([
    `v1=${"a".repeat(64)}`,
    `t=${T}`,
    `t=${T},v1=abc`,
    `t=now,v1=${"a".repeat(64)}`,
    `t=${T},t=${T},v1=${"a".repeat(64)}`,
    `t=${T};v1=${"a".repeat(64)}`,
  ])("rejects the malformed header %j", async (header) => {
    expect(await rejection(verify({ "x-shade-signature-v2": header }))).toBe("malformed_signature");
  });
});

describe("verifyWebhook body-only fallback (X-Shade-Signature)", () => {
  it("is refused by default: without V2 a captured delivery would verify forever", async () => {
    const { legacy } = reference(SECRET, BODY, T);
    expect(await rejection(verify({ "x-shade-signature": legacy }))).toBe("missing_signature");
    expect(
      await rejection(verify({ "x-shade-signature-v2": " ", "x-shade-signature": legacy })),
    ).toBe("missing_signature");
  });
});

describe("verifyWebhook body-only fallback with allowLegacySignature", () => {
  const verify = (headers: WebhookHeaders, body: string | Uint8Array = BODY) =>
    verifyWebhook(body, headers, SECRET, { now: NOW, allowLegacySignature: true });

  it("is used when V2 is absent", async () => {
    const { legacy } = reference(SECRET, BODY, T);
    await expect(verify(new Headers({ "X-Shade-Signature": legacy }))).resolves.toMatchObject({
      id: "evt_1",
    });
    await expect(
      verify({ "X-Shade-Signature": legacy.toUpperCase().replace("SHA256=", "sha256=") }),
    ).resolves.toBeDefined();
  });

  it("treats an empty V2 header as absent", async () => {
    const { legacy } = reference(SECRET, BODY, T);
    await expect(
      verify({ "x-shade-signature-v2": " ", "x-shade-signature": legacy }),
    ).resolves.toBeDefined();
  });

  it("rejects a tampered body and malformed values", async () => {
    const { legacy } = reference(SECRET, BODY, T);
    expect(await rejection(verify({ "x-shade-signature": legacy }, `${BODY} `))).toBe(
      "signature_mismatch",
    );
    expect(await rejection(verify({ "x-shade-signature": legacy.slice("sha256=".length) }))).toBe(
      "malformed_signature",
    );
    expect(await rejection(verify({ "x-shade-signature": [legacy, legacy] }))).toBe(
      "malformed_signature",
    );
  });

  it("fails with missing_signature when neither header is present", async () => {
    expect(await rejection(verify({}))).toBe("missing_signature");
    expect(await rejection(verify(new Headers()))).toBe("missing_signature");
  });
});

describe("verifyWebhook payload and arguments", () => {
  async function signed(body: string | Uint8Array) {
    return { "x-shade-signature-v2": (await signWebhook(SECRET, body, T))["X-Shade-Signature-V2"] };
  }

  it.each([
    ["not JSON", "not json"],
    ["a JSON array", "[]"],
    ["an object without id/type", '{"hello":"world"}'],
    ["an event without network", JSON.stringify({ ...wireEvent, network: undefined })],
  ])("rejects a correctly signed body that is %s", async (_, body) => {
    expect(await rejection(verify(await signed(body), body))).toBe("invalid_payload");
  });

  it("rejects a correctly signed body that is not UTF-8", async () => {
    const body = new Uint8Array([0x7b, 0xff, 0x7d]);
    expect(await rejection(verify(await signed(body), body))).toBe("invalid_payload");
  });

  it("requires the raw body and a secret", async () => {
    const headers = await signed(BODY);
    await expect(verifyWebhook(JSON.parse(BODY) as string, headers, SECRET)).rejects.toThrow(
      TypeError,
    );
    await expect(verifyWebhook(BODY, headers, "")).rejects.toThrow(TypeError);
    await expect(verifyWebhook(BODY, headers, SECRET, { toleranceSec: -1 })).rejects.toThrow(
      TypeError,
    );
  });

  it("maps a webhook.test event with null invoice fields", async () => {
    const body = JSON.stringify({
      ...wireEvent,
      id: "evt_test",
      type: "webhook.test",
      invoice_id: null,
      amount_zec: null,
      memo_hash: null,
      txid: null,
      paid_at: null,
      verification: null,
    });
    await expect(verify(await signed(body), body)).resolves.toStrictEqual({
      id: "evt_test",
      type: "webhook.test",
      createdAt: wireEvent.created_at,
      network: "testnet",
      invoiceId: null,
      amountZec: null,
      memoHash: null,
      txid: null,
      paidAt: null,
      verification: null,
    });
  });
});
