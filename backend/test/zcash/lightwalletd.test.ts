import type { ServerHttp2Stream } from "node:http2";
import { afterEach, describe, expect, it } from "vitest";
import { concatBytes } from "../../src/zcash/bytes.ts";
import { ChainUnavailableError, createLightwalletdClient } from "../../src/zcash/lightwalletd.ts";
import { encodeBytesField, encodeUint64Field } from "../../src/zcash/protobuf.ts";
import { parseTxSummary } from "../../src/zcash/tx.ts";
import { hex, recordedTransaction } from "./fixtures.ts";
import {
  RECORDED,
  type Reply,
  ZAINO_INFO,
  blockId,
  closeReplayServers,
  closedPortUrl,
  compactBlock,
  frame,
  ok,
  rawTransaction,
  serve,
  silent,
  status,
} from "./grpc-replay.ts";

const TXID = RECORDED.getTransaction.txid;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const chainInfo = (chainName: string): Reply => ok(encodeBytesField(4, utf8(chainName)));

afterEach(closeReplayServers);

const client = (urls: string[], timeoutMs = 2_000) =>
  createLightwalletdClient({ urls, network: "testnet", timeoutMs });

async function chainError(promise: Promise<unknown>): Promise<ChainUnavailableError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChainUnavailableError);
  return err as ChainUnavailableError;
}

describe("lightwalletd client: recorded testnet responses", () => {
  it("decodes GetLatestBlock and reverses the hash to display order", async () => {
    const server = await serve({ GetLatestBlock: ok(hex(RECORDED.getLatestBlock.body)) });
    const tip = await client([server.url]).getTip();
    expect(tip.height).toBe(RECORDED.getLatestBlock.height);
    expect(tip.hash).toMatch(/^0000[0-9a-f]{60}$/); // proof-of-work zeros lead in display order
    expect(server.requests.map((r) => r.method)).toEqual(["GetLightdInfo", "GetLatestBlock"]);
  });

  it("decodes a CompactBlock, skipping its transactions", async () => {
    const server = await serve({ GetBlock: ok(hex(RECORDED.getBlock.body)) });
    const block = await client([server.url]).getBlock(4_433_692);
    // Cross-checked against testnet.zecblock.com's API for the same block.
    expect(block).toEqual({
      height: 4_433_692,
      hash: "00000fe926013f119b7edd437129b68894b1987fcc772057d6f5738d1bacb953",
      time: 1_790_949_285,
    });
    expect(server.requests[1]!.body).toEqual(encodeUint64Field(1, 4_433_692));
  });

  it("decodes GetTransaction and sends the txid in protocol byte order", async () => {
    const server = await serve({
      GetTransaction: ok(hex(RECORDED.getTransaction.body)),
      GetBlock: ok(hex(RECORDED.getBlock.body)),
    });
    const lookup = await client([server.url]).getTransaction(TXID);
    expect(lookup.kind).toBe("mined");
    if (lookup.kind !== "mined") return;
    expect(lookup.height).toBe(4_433_692);
    expect(Buffer.from(lookup.raw).toString("hex")).toBe(recordedTransaction(TXID).hex);
    expect(parseTxSummary(lookup.raw).ironwoodActions).toBe(2);
    const sent = server.requests[1]!.body;
    expect(sent).toEqual(encodeBytesField(3, hex(TXID).reverse()));
    // The recorded block at that height lists the transaction, which is what proves it mined.
    expect(server.requests.map((r) => r.method)).toEqual([
      "GetLightdInfo",
      "GetTransaction",
      "GetBlock",
    ]);
    expect(server.requests[2]!.body).toEqual(encodeUint64Field(1, 4_433_692));
  });

  it("decodes GetLightdInfo", async () => {
    const server = await serve({});
    expect(await client([server.url]).getInfo()).toEqual({
      chainName: "test",
      blockHeight: expect.any(Number),
      version: "v0.5.4",
      vendor: "ECC LightWalletD",
      upgradeName: null,
      upgradeHeight: null,
    });
  });

  it("reports the next upgrade when the server announces one", async () => {
    const info = concatBytes([
      encodeBytesField(4, utf8("test")),
      encodeUint64Field(7, 4_433_000),
      encodeBytesField(16, utf8("Nu7")),
      encodeUint64Field(17, 4_465_026),
    ]);
    const server = await serve({ GetLightdInfo: ok(info) });
    expect(await client([server.url]).getInfo()).toMatchObject({
      upgradeName: "Nu7",
      upgradeHeight: 4_465_026,
    });
  });

  it("sends gRPC request headers", async () => {
    const server = await serve({ GetLatestBlock: ok(hex(RECORDED.getLatestBlock.body)) });
    await client([server.url], 5_000).getTip();
    expect(server.requests[1]!.headers).toMatchObject({
      ":method": "POST",
      ":path": "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock",
      "content-type": "application/grpc",
      te: "trailers",
      "grpc-timeout": "5000m",
    });
  });
});

describe("lightwalletd client: transaction states", () => {
  const raw = hex(recordedTransaction(TXID).hex);

  it.each([
    ["mempool (height 0)", encodeBytesField(1, raw), { kind: "mempool", raw }],
    [
      "orphaned (height 2^64-1)",
      concatBytes([encodeBytesField(1, raw), encodeUint64Field(2, (1n << 64n) - 1n)]),
      { kind: "orphaned" },
    ],
    [
      "mined",
      concatBytes([encodeBytesField(1, raw), encodeUint64Field(2, 4_433_692)]),
      { kind: "mined", height: 4_433_692, raw },
    ],
  ] as const)("%s", async (_name, body, expected) => {
    const server = await serve({
      GetTransaction: ok(body),
      GetBlock: ok(hex(RECORDED.getBlock.body)),
    });
    expect(await client([server.url]).getTransaction(TXID)).toEqual(expected);
  });

  it("maps NOT_FOUND to not_found without asking the next server", async () => {
    const first = await serve({ GetTransaction: status(5) });
    const second = await serve({ GetTransaction: ok(hex(RECORDED.getTransaction.body)) });
    expect(await client([first.url, second.url]).getTransaction(TXID)).toEqual({
      kind: "not_found",
    });
    expect(second.requests).toHaveLength(0);
  });

  it("returns null for blocks above the tip (OUT_OF_RANGE or NOT_FOUND)", async () => {
    const server = await serve({ GetBlock: [status(11), status(5)] });
    const c = client([server.url]);
    expect(await c.getBlock(9_999_999)).toBeNull();
    expect(await c.getBlock(9_999_999)).toBeNull();
  });

  it("validates arguments before any network call", async () => {
    const c = client(["http://127.0.0.1:1"]);
    await expect(c.getTransaction("xyz")).rejects.toThrow(RangeError);
    await expect(c.getBlock(0)).rejects.toThrow(RangeError);
    await expect(c.getBlock(1.5)).rejects.toThrow(RangeError);
  });
});

describe("lightwalletd client: ZainoD (the default testnet fallback)", () => {
  // Its answer to GetTransaction for an unknown txid: a trailers-only INTERNAL, with the same
  // message it sends when the backing node is down. LightWalletD answers NOT_FOUND instead.
  const zainoUnknownTx: Reply = (stream) => {
    stream.respond(
      {
        ":status": 200,
        "content-type": "application/grpc",
        "grpc-status": "13",
        "grpc-message": "InternalServerError:%20error%20receiving%20data%20from%20backing%20node",
      },
      { endStream: true },
    );
  };
  const zaino = () => serve({ GetLightdInfo: ok(hex(ZAINO_INFO)), GetTransaction: zainoUnknownTx });

  it("decodes its GetLightdInfo", async () => {
    const server = await zaino();
    expect(await client([server.url]).getInfo()).toMatchObject({
      chainName: "test",
      vendor: "ZingoLabs ZainoD",
      version: "0.6.0",
      upgradeName: "Nu6_3",
      upgradeHeight: 4_134_000,
    });
  });

  it("treats its INTERNAL answer for an unknown txid as unavailable, never not_found", async () => {
    // Indistinguishable from a backing-node outage: mapping it to not_found would let promotion
    // orphan valid detections whenever Zaino's node is down.
    const server = await zaino();
    const err = await chainError(client([server.url]).getTransaction(TXID));
    expect(err.reason).toBe("grpc_status");
  });

  it("so an unknown txid is unavailable while the primary is down", async () => {
    const server = await zaino();
    const err = await chainError(client([await closedPortUrl(), server.url]).getTransaction(TXID));
    expect(err.reason).toBe("grpc_status");
    expect(server.requests.map((r) => r.method)).toEqual(["GetLightdInfo", "GetTransaction"]);
  });

  describe("answers a mempool transaction with the tip height", () => {
    // Observed live 2026-10-03 for unmined testnet txs (ade3c12b…, 00a71816…): ZainoD 0.6.0 said
    // height = its tip while ECC LightWalletD said 0 (mempool); each was mined one block later.
    const TIP = 4_435_601;
    const raw = hex(recordedTransaction(TXID).hex);
    const zainoMempool = (block: Reply) =>
      serve({
        GetLightdInfo: ok(hex(ZAINO_INFO)),
        GetLatestBlock: ok(blockId(TIP)),
        GetTransaction: ok(rawTransaction(raw, TIP)),
        GetBlock: block,
      });

    it("so a transaction missing from the block at that height is mempool, not mined", async () => {
      const server = await zainoMempool(ok(compactBlock(TIP, ["11".repeat(32), "22".repeat(32)])));
      expect(await client([server.url]).getTransaction(TXID)).toEqual({ kind: "mempool", raw });
      expect(server.requests.map((r) => r.method)).toEqual([
        "GetLightdInfo",
        "GetTransaction",
        "GetBlock",
      ]);
      expect(server.requests[2]!.body).toEqual(encodeUint64Field(1, TIP));
    });

    it("and an empty block at that height is mempool too", async () => {
      const server = await zainoMempool(ok(compactBlock(TIP, [])));
      expect((await client([server.url]).getTransaction(TXID)).kind).toBe("mempool");
    });

    it("while one really mined in the tip block is listed there and stays mined", async () => {
      const server = await zainoMempool(ok(compactBlock(TIP, ["11".repeat(32), TXID])));
      expect(await client([server.url]).getTransaction(TXID)).toEqual({
        kind: "mined",
        height: TIP,
        raw,
      });
    });

    it("asks the next server for a block this one does not have, else is unavailable", async () => {
      // A height above the block cache (a lagging or leading server) is never taken as mined.
      for (const missing of [status(5), status(11)]) {
        const lone = await zainoMempool(missing);
        expect((await chainError(client([lone.url]).getTransaction(TXID))).reason).toBe(
          "grpc_status",
        );
      }
      const lagging = await zainoMempool(status(11));
      const caughtUp = await serve({ GetBlock: ok(compactBlock(TIP, [TXID])) });
      expect((await client([lagging.url, caughtUp.url]).getTransaction(TXID)).kind).toBe("mined");
      expect(caughtUp.requests.map((r) => r.method)).toEqual(["GetLightdInfo", "GetBlock"]);
    });

    it("is unavailable when the block cannot be read, never mined", async () => {
      for (const [reply, reason] of [
        [status(14), "grpc_status"],
        // A block for another height.
        [ok(compactBlock(TIP + 1, [TXID])), "bad_response"],
        // A compact transaction whose txid is not 32 bytes.
        [
          ok(concatBytes([encodeUint64Field(2, TIP), Uint8Array.of(0x3a, 0x03, 0x12, 0x01, 0x00)])),
          "bad_response",
        ],
        // A truncated compact transaction.
        [
          ok(concatBytes([encodeUint64Field(2, TIP), Uint8Array.of(0x3a, 0x02, 0x12, 0x09)])),
          "bad_response",
        ],
      ] as const) {
        const server = await zainoMempool(reply);
        expect((await chainError(client([server.url]).getTransaction(TXID))).reason).toBe(reason);
      }
    });
  });

  it("is not asked when the primary answers NOT_FOUND", async () => {
    const primary = await serve({ GetTransaction: status(5) });
    const fallback = await zaino();
    expect(await client([primary.url, fallback.url]).getTransaction(TXID)).toEqual({
      kind: "not_found",
    });
    expect(fallback.requests).toHaveLength(0);
  });
});

describe("lightwalletd client: failover and failures", () => {
  it("fails over when a server refuses connections", async () => {
    const server = await serve({ GetLatestBlock: ok(hex(RECORDED.getLatestBlock.body)) });
    const tip = await client([await closedPortUrl(), server.url]).getTip();
    expect(tip.height).toBe(RECORDED.getLatestBlock.height);
  });

  it("fails over on gRPC errors other than NOT_FOUND", async () => {
    const first = await serve({ GetTransaction: status(14), GetBlock: status(14) });
    const second = await serve({
      GetTransaction: ok(hex(RECORDED.getTransaction.body)),
      GetBlock: ok(hex(RECORDED.getBlock.body)),
    });
    expect((await client([first.url, second.url]).getTransaction(TXID)).kind).toBe("mined");
  });

  it("throws ChainUnavailableError with a fixed reason when every server fails", async () => {
    const server = await serve({ GetTransaction: status(13) });
    const err = await chainError(client([server.url, await closedPortUrl()]).getTransaction(TXID));
    expect(err.reason).toBe("transport");
    expect(err.message).toBe("Zcash light server unavailable");
    expect(err.message).not.toContain("127.0.0.1");
    const only = await chainError(client([server.url]).getTransaction(TXID));
    expect(only.reason).toBe("grpc_status");
  });

  it("refuses a server on the wrong network", async () => {
    const mainnet = await serve({
      GetLightdInfo: chainInfo("main"),
      GetLatestBlock: ok(hex(RECORDED.getLatestBlock.body)),
    });
    expect((await chainError(client([mainnet.url]).getTip())).reason).toBe("wrong_network");
    expect(mainnet.requests.map((r) => r.method)).toEqual(["GetLightdInfo"]);
    const testnet = await serve({ GetLatestBlock: ok(hex(RECORDED.getLatestBlock.body)) });
    expect((await client([mainnet.url, testnet.url]).getTip()).height).toBe(
      RECORDED.getLatestBlock.height,
    );
  });

  it("times out a silent server and moves on", async () => {
    const stuck = await serve({ GetLatestBlock: silent });
    const err = await chainError(client([stuck.url], 200).getTip());
    expect(err.reason).toBe("timeout");
    const healthy = await serve({ GetLatestBlock: ok(hex(RECORDED.getLatestBlock.body)) });
    expect((await client([stuck.url, healthy.url], 200).getTip()).height).toBe(
      RECORDED.getLatestBlock.height,
    );
  });

  it.each([
    ["a compressed frame", ok(hex(RECORDED.getLatestBlock.body), 1), "bad_response"],
    [
      "an HTTP error",
      (s: ServerHttp2Stream) => s.respond({ ":status": 503 }, { endStream: true }),
      "http_status",
    ],
    [
      "a non-gRPC content type",
      (s: ServerHttp2Stream) =>
        s.respond({ ":status": 200, "content-type": "text/html" }, { endStream: true }),
      "bad_response",
    ],
    [
      "a missing grpc-status",
      (s: ServerHttp2Stream) => {
        s.respond({ ":status": 200, "content-type": "application/grpc" });
        s.end(frame(hex(RECORDED.getLatestBlock.body)));
      },
      "bad_response",
    ],
    ["a truncated protobuf", ok(Uint8Array.of(0x08, 0x80)), "bad_response"],
    [
      "a short block hash",
      ok(concatBytes([encodeUint64Field(1, 5), encodeBytesField(2, new Uint8Array(31))])),
      "bad_response",
    ],
    ["a reset stream", (s: ServerHttp2Stream) => s.close(2), "transport"],
  ] as const)("rejects %s", async (_name, reply, reason) => {
    const server = await serve({ GetLatestBlock: reply });
    expect((await chainError(client([server.url]).getTip())).reason).toBe(reason);
  });

  it("rejects a block for a different height and a mined transaction without data", async () => {
    const server = await serve({
      GetBlock: ok(hex(RECORDED.getBlock.body)),
      GetTransaction: ok(encodeUint64Field(2, 4_433_692)),
    });
    const c = client([server.url]);
    expect((await chainError(c.getBlock(4_433_693))).reason).toBe("bad_response");
    expect((await chainError(c.getTransaction(TXID))).reason).toBe("bad_response");
  });
});

describe("lightwalletd client: sessions", () => {
  it("reuses one verified session for sequential calls", async () => {
    const server = await serve({ GetLatestBlock: ok(hex(RECORDED.getLatestBlock.body)) });
    const c = client([server.url]);
    await c.getTip();
    await c.getTip();
    await c.getTip();
    expect(server.sessions()).toBe(1);
    expect(server.requests.filter((r) => r.method === "GetLightdInfo")).toHaveLength(1);
  });

  it("reconnects after the server sends GOAWAY", async () => {
    const goawayAfterReply: Reply = (stream) => {
      const session = stream.session;
      ok(hex(RECORDED.getLatestBlock.body))(stream);
      stream.on("close", () => session?.goaway());
    };
    const server = await serve({ GetLatestBlock: goawayAfterReply });
    const c = client([server.url]);
    await c.getTip();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await c.getTip();
    expect(server.sessions()).toBe(2);
  });

  it("rejects invalid configuration", () => {
    expect(() => createLightwalletdClient({ urls: [], network: "testnet" })).toThrow(RangeError);
    expect(() =>
      createLightwalletdClient({ urls: ["ftp://example.com"], network: "testnet" }),
    ).toThrow(RangeError);
    expect(() => createLightwalletdClient({ urls: ["not a url"], network: "testnet" })).toThrow();
    expect(() =>
      createLightwalletdClient({ urls: ["http://127.0.0.1:1"], network: "testnet", timeoutMs: 0 }),
    ).toThrow(RangeError);
  });
});
