import { Duplex } from "node:stream";
import type { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { postgresPoolConfig } from "../../../src/platform/db.ts";

const TERMINATE = 0x58; // 'X'

/**
 * A socket stand-in that feeds the Postgres wire protocol from node-postgres into PGlite. It lets
 * tests drive the real `pg` code paths (type parsers, pooled transactions, multi-statement simple
 * queries) without a server. PGlite is one session, so a pool over it must have `max: 1`.
 */
class PgliteWireStream extends Duplex {
  readonly #pglite: PGlite;
  #pending = Buffer.alloc(0);
  #startupDone = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(pglite: PGlite) {
    super();
    this.#pglite = pglite;
  }

  connect(): this {
    queueMicrotask(() => this.emit("connect"));
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  // pg-pool (un)refs idle client sockets; there is no handle to keep the event loop alive.
  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (err?: Error | null) => void,
  ): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    for (const message of this.#takeMessages()) {
      this.#queue = this.#queue.then(async () => {
        if (message[0] === TERMINATE && this.#startupDone) {
          this.push(null);
          return;
        }
        const reply = await this.#pglite.execProtocolRaw(new Uint8Array(message));
        if (reply.length > 0) this.push(Buffer.from(reply));
      });
    }
    this.#queue.then(() => callback(), callback);
  }

  /** Splits buffered bytes into whole messages (the startup message has no type byte). */
  #takeMessages(): Buffer[] {
    const messages: Buffer[] = [];
    for (;;) {
      const headerBytes = this.#startupDone ? 5 : 4;
      if (this.#pending.length < headerBytes) break;
      const length = this.#startupDone
        ? this.#pending.readInt32BE(1) + 1
        : this.#pending.readInt32BE(0);
      if (this.#pending.length < length) break;
      messages.push(this.#pending.subarray(0, length));
      this.#pending = this.#pending.subarray(length);
      this.#startupDone = true;
    }
    return messages;
  }
}

/** A single-connection pg Pool (with Shade's pool settings and type parsers) over `pglite`. */
export function pgliteWirePool(pglite: PGlite): pg.Pool {
  return new pg.Pool({
    ...postgresPoolConfig("postgres://postgres@localhost/postgres"),
    max: 1,
    stream: () => new PgliteWireStream(pglite),
  });
}
