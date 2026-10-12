/**
 * lightwalletd / Zaino client: unary gRPC over node:http2 with a minimal protobuf codec
 * (cash.z.wallet.sdk.rpc.CompactTxStreamer, lightwallet-protocol v0.5.0).
 *
 * - URLs are tried in order; any failure other than a definitive answer moves to the next one.
 * - One HTTP/2 session per URL is reused until the server sends GOAWAY, it errors or idles out.
 * - Each new session first checks GetLightdInfo.chainName so a misconfigured URL never answers
 *   for the wrong network.
 * - Hashes and txids are display order at this boundary; the wire uses protocol (reversed) order.
 * - Errors carry fixed reason codes only: never URLs, txids or server messages.
 */
import { connect, constants } from "node:http2";
import type { ClientHttp2Session, IncomingHttpHeaders, IncomingHttpStatusHeader } from "node:http2";
import type { Network } from "../contract/index.ts";
import { bytesToHex, concatBytes } from "./bytes.ts";
import { ProtoMessage, encodeBytesField, encodeUint64Field } from "./protobuf.ts";
import { txidToProtocolBytes } from "./txid.ts";

/**
 * Public light servers verified 2026-10-02, tried in order on transport errors. Run your own for
 * mainnet privacy. The testnet fallback (ZainoD 0.6.0) answers an unknown txid with INTERNAL, the
 * same status as a backing-node failure, so while the primary is down an unknown txid is
 * ChainUnavailableError rather than not_found (fail closed; never mapped).
 */
export const DEFAULT_LIGHTWALLETD_URLS: Readonly<Record<Network, readonly string[]>> = {
  testnet: ["https://testnet.zec.rocks:443", "https://zaino.testnet.unsafe.zec.rocks:443"],
  mainnet: ["https://zec.rocks:443", "https://zec-node.cakewallet.com:443"],
};

export interface ChainTip {
  height: number;
  hash: string;
}
export interface ChainBlock {
  height: number;
  hash: string;
  /** Unix seconds. */
  time: number;
}
export type TxLookup =
  | { kind: "mined"; height: number; raw: Uint8Array }
  | { kind: "mempool"; raw: Uint8Array }
  | { kind: "orphaned" }
  | { kind: "not_found" };
export interface ChainInfo {
  chainName: string;
  blockHeight: number;
  version: string;
  vendor: string;
  upgradeName: string | null;
  upgradeHeight: number | null;
}
export interface ChainClient {
  readonly network: Network;
  getTip(): Promise<ChainTip>;
  /** null when the server has no block at that height (above the tip). */
  getBlock(height: number): Promise<ChainBlock | null>;
  /**
   * "mined" only when the transaction is listed in the compact block at the reported height.
   * Whether a server lists transparent-only transactions there varies (lightwalletd 0.5 does), so
   * check that a transaction can pay a shielded receiver before reading anything into its state.
   */
  getTransaction(txid: string): Promise<TxLookup>;
  getInfo(): Promise<ChainInfo>;
}

export type ChainFailure =
  "timeout" | "transport" | "http_status" | "grpc_status" | "bad_response" | "wrong_network";

/** No configured light server gave a usable answer. */
export class ChainUnavailableError extends Error {
  override name = "ChainUnavailableError";
  readonly reason: ChainFailure;

  constructor(message = "Zcash light server unavailable", reason: ChainFailure = "transport") {
    super(message);
    this.reason = reason;
  }
}

const SERVICE_PATH = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/";
const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_IDLE_MS = 60_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const GRPC_OK = 0;
const GRPC_NOT_FOUND = 5;
const GRPC_OUT_OF_RANGE = 11;
const HEIGHT_ORPHANED = (1n << 64n) - 1n;
const EMPTY = new Uint8Array(0);

/** A failed attempt against one server; the client then tries the next URL. */
class CallFailure extends Error {
  readonly reason: ChainFailure;

  constructor(reason: ChainFailure) {
    super(reason);
    this.reason = reason;
  }
}

interface UnaryResult {
  status: number;
  body: Uint8Array;
}

function grpcFrame(message: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(1, message.length);
  return concatBytes([header, message]);
}

/** Exactly one uncompressed length-prefixed message. */
function unframe(body: Uint8Array): Uint8Array {
  if (body.length < 5 || body[0] !== 0) throw new CallFailure("bad_response");
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1);
  if (body.length !== 5 + length) throw new CallFailure("bad_response");
  return body.subarray(5);
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CallFailure("bad_response");
  return Number(value);
}

function displayHash(protocolOrder: Uint8Array): string {
  if (protocolOrder.length !== 32) throw new CallFailure("bad_response");
  return bytesToHex(Uint8Array.from(protocolOrder).reverse());
}

function networkOfChainName(chainName: string): Network | null {
  if (chainName === "main" || chainName === "mainnet") return "mainnet";
  if (chainName === "test" || chainName === "testnet") return "testnet";
  return null;
}

function decodeInfo(body: Uint8Array): ChainInfo {
  const msg = new ProtoMessage(body);
  const upgradeHeight = safeNumber(msg.uint64(17));
  return {
    version: msg.string(1),
    vendor: msg.string(2),
    chainName: msg.string(4),
    blockHeight: safeNumber(msg.uint64(7)),
    upgradeName: msg.string(16) || null,
    upgradeHeight: upgradeHeight === 0 ? null : upgradeHeight,
  };
}

/** CompactBlock.vtx[].txid (fields 7 and 2), hex in protocol byte order. */
function blockTxids(block: ProtoMessage): Set<string> {
  const txids = new Set<string>();
  for (const tx of block.repeatedBytes(7)) {
    const txid = new ProtoMessage(tx).bytes(2);
    if (txid.length !== 32) throw new CallFailure("bad_response");
    txids.add(bytesToHex(txid));
  }
  return txids;
}

/** One server URL and its reusable HTTP/2 session. */
class Endpoint {
  readonly #url: string;
  readonly #network: Network;
  readonly #timeoutMs: number;
  #session: ClientHttp2Session | null = null;
  #verified: ClientHttp2Session | null = null;

  constructor(url: string, network: Network, timeoutMs: number) {
    this.#url = url;
    this.#network = network;
    this.#timeoutMs = timeoutMs;
  }

  /** Runs a call on a session whose chain matches the client's network. */
  async call(method: string, request: Uint8Array): Promise<UnaryResult> {
    const session = this.#currentSession();
    if (this.#verified !== session) {
      const info = await this.#unary(session, "GetLightdInfo", EMPTY);
      if (info.status !== GRPC_OK) throw new CallFailure("grpc_status");
      let chain: Network | null;
      try {
        chain = networkOfChainName(decodeInfo(info.body).chainName);
      } catch {
        throw new CallFailure("bad_response");
      }
      if (chain !== this.#network) throw new CallFailure("wrong_network");
      this.#verified = session;
    }
    return this.#unary(session, method, request);
  }

  /** Destroys a session that stopped answering, so the next call reconnects. */
  #drop(session: ClientHttp2Session): void {
    if (this.#session === session) {
      this.#session = null;
      this.#verified = null;
    }
    session.destroy();
  }

  #currentSession(): ClientHttp2Session {
    const existing = this.#session;
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(this.#url);
    const forget = (): void => {
      if (this.#session === session) {
        this.#session = null;
        this.#verified = null;
      }
    };
    // A session error is also reported to its streams; the listener keeps it from being fatal.
    session.on("error", forget);
    session.on("goaway", forget);
    session.on("close", forget);
    session.setTimeout(SESSION_IDLE_MS, () => session.close());
    session.unref();
    this.#session = session;
    return session;
  }

  #unary(session: ClientHttp2Session, method: string, request: Uint8Array): Promise<UnaryResult> {
    return new Promise<UnaryResult>((resolve, reject) => {
      let settled = false;
      let headers: (IncomingHttpHeaders & IncomingHttpStatusHeader) | undefined;
      let trailers: IncomingHttpHeaders | undefined;
      const chunks: Buffer[] = [];
      let received = 0;

      const stream = session.request({
        ":method": "POST",
        ":path": SERVICE_PATH + method,
        "content-type": "application/grpc",
        te: "trailers",
        "grpc-timeout": `${this.#timeoutMs}m`,
      });
      const fail = (reason: ChainFailure): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL);
        // A silent server usually means a dead connection: reconnect on the next call.
        if (reason === "timeout") this.#drop(session);
        reject(new CallFailure(reason));
      };
      const timer = setTimeout(() => fail("timeout"), this.#timeoutMs);

      stream.on("response", (h) => {
        headers = h;
      });
      stream.on("trailers", (t) => {
        trailers = t;
      });
      stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) fail("bad_response");
        else chunks.push(chunk);
      });
      stream.on("error", () => fail("transport"));
      stream.on("close", () => {
        if (settled) return;
        if (!headers) return fail("transport");
        if (headers[":status"] !== 200) return fail("http_status");
        if (!String(headers["content-type"] ?? "").startsWith("application/grpc"))
          return fail("bad_response");
        // Trailers-only responses carry grpc-status in the headers.
        const rawStatus = trailers?.["grpc-status"] ?? headers["grpc-status"];
        const status = Number(rawStatus);
        if (rawStatus === undefined || !Number.isInteger(status)) return fail("bad_response");
        let body: Uint8Array = EMPTY;
        if (status === GRPC_OK) {
          try {
            body = unframe(Buffer.concat(chunks));
          } catch {
            return fail("bad_response");
          }
        }
        settled = true;
        clearTimeout(timer);
        resolve({ status, body });
      });
      stream.end(grpcFrame(request));
    });
  }
}

/**
 * Creates a client for one network. `urls` is the ordered failover list (https: uses TLS,
 * http: is plaintext); `timeoutMs` bounds each attempt.
 */
export function createLightwalletdClient(opts: {
  urls: string[];
  network: Network;
  timeoutMs?: number;
}): ChainClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("timeoutMs must be a positive integer");
  if (opts.urls.length === 0) throw new RangeError("At least one lightwalletd URL is required");
  const endpoints = opts.urls.map((url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new RangeError("lightwalletd URLs must use https: or http:");
    }
    return new Endpoint(parsed.origin, opts.network, timeoutMs);
  });

  /** Tries each server until `handle` accepts a response; `handle` throws CallFailure to move on. */
  async function request<T>(
    method: string,
    message: Uint8Array,
    handle: (r: UnaryResult) => T,
  ): Promise<T> {
    let reason: ChainFailure = "transport";
    for (const endpoint of endpoints) {
      let result: UnaryResult;
      try {
        result = await endpoint.call(method, message);
      } catch (err) {
        reason = err instanceof CallFailure ? err.reason : "transport";
        continue;
      }
      try {
        return handle(result);
      } catch (err) {
        reason = err instanceof CallFailure ? err.reason : "bad_response";
      }
    }
    throw new ChainUnavailableError(undefined, reason);
  }

  const expectOk = (r: UnaryResult): ProtoMessage => {
    if (r.status !== GRPC_OK) throw new CallFailure("grpc_status");
    return new ProtoMessage(r.body);
  };

  return {
    network: opts.network,

    getTip: () =>
      request("GetLatestBlock", EMPTY, (r) => {
        const msg = expectOk(r);
        const height = safeNumber(msg.uint64(1));
        if (height < 1) throw new CallFailure("bad_response");
        return { height, hash: displayHash(msg.bytes(2)) };
      }),

    getBlock: (height) => {
      if (!Number.isSafeInteger(height) || height < 1) {
        return Promise.reject(new RangeError("Block height must be a positive integer"));
      }
      return request("GetBlock", encodeUint64Field(1, height), (r) => {
        if (r.status === GRPC_NOT_FOUND || r.status === GRPC_OUT_OF_RANGE) return null;
        const msg = expectOk(r);
        const time = safeNumber(msg.uint64(5));
        if (safeNumber(msg.uint64(2)) !== height || time === 0)
          throw new CallFailure("bad_response");
        return { height, hash: displayHash(msg.bytes(3)), time };
      });
    },

    getTransaction: async (txid) => {
      const wireTxid = txidToProtocolBytes(txid);
      const found = await request(
        "GetTransaction",
        encodeBytesField(3, wireTxid),
        (r): TxLookup => {
          if (r.status === GRPC_NOT_FOUND) return { kind: "not_found" };
          const msg = expectOk(r);
          const height = msg.uint64(2);
          if (height === HEIGHT_ORPHANED) return { kind: "orphaned" };
          const raw = Uint8Array.from(msg.bytes(1));
          if (raw.length === 0) throw new CallFailure("bad_response");
          return height === 0n
            ? { kind: "mempool", raw }
            : { kind: "mined", height: safeNumber(height), raw };
        },
      );
      if (found.kind !== "mined") return found;

      // RawTransaction.height alone is not proof of mining: ZainoD 0.6.0 (the default testnet
      // fallback) answers a mempool transaction with its current tip height, which would count
      // as one confirmation. A mined transaction with shielded parts (every transaction Shade can
      // receive has them) is always listed in the compact block at its height, so a transaction
      // missing from that block is answered as unmined. A server
      // without the block is lagging or wrong: the next one is asked, and when none has it the
      // lookup is unavailable, never "mined".
      const wireHex = bytesToHex(wireTxid);
      const inBlock = await request(
        "GetBlock",
        encodeUint64Field(1, found.height),
        (r): boolean => {
          if (r.status === GRPC_NOT_FOUND || r.status === GRPC_OUT_OF_RANGE)
            throw new CallFailure("grpc_status");
          const msg = expectOk(r);
          if (safeNumber(msg.uint64(2)) !== found.height) throw new CallFailure("bad_response");
          return blockTxids(msg).has(wireHex);
        },
      );
      return inBlock ? found : { kind: "mempool", raw: found.raw };
    },

    getInfo: () =>
      request("GetLightdInfo", EMPTY, (r) => {
        if (r.status !== GRPC_OK) throw new CallFailure("grpc_status");
        return decodeInfo(r.body);
      }),
  };
}
