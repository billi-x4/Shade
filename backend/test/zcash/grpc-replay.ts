/**
 * A local plaintext HTTP/2 server that replays lightwalletd gRPC answers, and builders for the
 * messages Shade decodes. Tests call closeReplayServers() after each test.
 */
import { createServer } from "node:http2";
import type { IncomingHttpHeaders, ServerHttp2Session, ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { concatBytes } from "../../src/zcash/bytes.ts";
import { encodeBytesField, encodeUint64Field } from "../../src/zcash/protobuf.ts";
import { txidToProtocolBytes } from "../../src/zcash/txid.ts";
import { hex, readFixture } from "./fixtures.ts";

export interface Recorded {
  getLatestBlock: { height: number; body: string };
  getBlock: { height: number; body: string };
  getLightdInfo: { body: string };
  getTransaction: { txid: string; body: string };
}
export const RECORDED = readFixture<Recorded>("lightwalletd-responses.json");

/**
 * GetLightdInfo recorded 2026-10-02 from zaino.testnet.unsafe.zec.rocks:443 (ZainoD 0.6.0 over
 * Zebra 6.3.0), the default testnet fallback.
 */
export const ZAINO_INFO =
  "0a05302e362e3012105a696e676f4c616273205a61696e6f44180122047465737428c08b113208333761353136356238f9d58e025207756e6b6e6f776e5a04726f6f7460f9d58e026a0676362e332e30720d2f5a656272613a362e332e302f8201054e75365f338801f0a8fc0192010676302e352e30";

export type Reply = (stream: ServerHttp2Stream) => void;
export interface ReplayRequest {
  method: string;
  body: Uint8Array;
  headers: IncomingHttpHeaders;
}

export function frame(message: Uint8Array, compressed = 0): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = compressed;
  new DataView(header.buffer).setUint32(1, message.length);
  return concatBytes([header, message]);
}

export const ok =
  (message: Uint8Array, compressed = 0): Reply =>
  (stream) => {
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end(frame(message, compressed));
  };

/** Trailers-only response, as servers send for errors. */
export const status =
  (code: number): Reply =>
  (stream) => {
    stream.respond(
      {
        ":status": 200,
        "content-type": "application/grpc",
        "grpc-status": String(code),
        "grpc-message": "error%20text",
      },
      { endStream: true },
    );
  };

export const silent: Reply = () => {};

export interface ReplayServer {
  url: string;
  requests: ReplayRequest[];
  sessions: () => number;
  close(): Promise<void>;
}

const servers: ReplayServer[] = [];

export async function closeReplayServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((s) => s.close()));
}

/** `routes` maps RPC method → reply, or one reply per call (GetLightdInfo defaults to testnet). */
export async function serve(routes: Record<string, Reply | Reply[]>): Promise<ReplayServer> {
  const requests: ReplayRequest[] = [];
  let sessions = 0;
  const calls = new Map<string, number>();
  const live = new Set<ServerHttp2Session>();
  const server = createServer();
  server.on("session", (session) => {
    sessions++;
    live.add(session);
    session.on("close", () => live.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const method = String(headers[":path"]).replace(
      "/cash.z.wallet.sdk.rpc.CompactTxStreamer/",
      "",
    );
    const chunks: Buffer[] = [];
    // Client cancellations and test resets surface here; they are expected.
    stream.on("error", () => {});
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const body = Buffer.concat(chunks).subarray(5);
      requests.push({ method, body: new Uint8Array(body), headers });
      const route =
        routes[method] ??
        (method === "GetLightdInfo" ? ok(hex(RECORDED.getLightdInfo.body)) : status(12));
      const n = calls.get(method) ?? 0;
      calls.set(method, n + 1);
      const reply = Array.isArray(route) ? route[Math.min(n, route.length - 1)]! : route;
      reply(stream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const handle: ReplayServer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    sessions: () => sessions,
    close: () =>
      new Promise<void>((resolve) => {
        // The client keeps idle sessions open; drop them so close() completes.
        for (const session of live) session.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(handle);
  return handle;
}

export async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** A RawTransaction answer: the tx bytes and the height the server reports (0 = mempool). */
export function rawTransaction(raw: Uint8Array, height: number | bigint): Uint8Array {
  return concatBytes([encodeBytesField(1, raw), encodeUint64Field(2, height)]);
}

/** A CompactBlock at `height` listing `txids` (display order) as its compact transactions. */
export function compactBlock(height: number, txids: string[], time = 1_790_979_420): Uint8Array {
  const vtx = txids.map((txid, index) =>
    encodeBytesField(
      7,
      concatBytes([
        encodeUint64Field(1, index),
        encodeBytesField(2, txidToProtocolBytes(txid)),
        // One Orchard-shaped action, as a shielded transaction carries.
        encodeBytesField(6, encodeBytesField(2, new Uint8Array(32))),
      ]),
    ),
  );
  return concatBytes([
    encodeUint64Field(2, height),
    encodeBytesField(3, new Uint8Array(32).fill(height % 251)),
    encodeUint64Field(5, time),
    ...vtx,
  ]);
}

/** GetLatestBlock (BlockID) answer. */
export function blockId(height: number): Uint8Array {
  return concatBytes([
    encodeUint64Field(1, height),
    encodeBytesField(2, new Uint8Array(32).fill(7)),
  ]);
}
