import { type DestinationStream, type Logger as PinoLogger, pino } from "pino";
import type { Config } from "./config.ts";

export type Logger = PinoLogger;

/**
 * Field names that must never reach a log line. Callers already avoid logging them (agents.md §5); the
 * redaction is a backstop for accidental `logger.info({ ...row })`, up to two levels deep.
 */
const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-shade-edge",
  "idempotency-key",
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "secret",
  "secret_ciphertext",
  "apiKey",
  "api_key",
  "key_hash",
  "token_hash",
  "memo",
  "chain_memo",
  "memo_hash",
  "zip321",
  "txid",
  "claimed_txid",
  "amount_zec",
  "address",
  "ufvk",
  "uivk",
  "viewing_key",
  "sealed_key",
  "privateKey",
  "private_key",
  "rawBody",
  "body",
];

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
    const child = segment.startsWith("[") ? segment : `.${segment}`;
    paths.push(segment, `*${child}`, `*.*${child}`);
  }
  return paths;
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  constraint?: unknown;
  stack?: unknown;
}

/**
 * Error serializer. Library and driver errors can embed input values in their messages (e.g.
 * Postgres "invalid input syntax for type numeric: …"), so production keeps only the type, code,
 * constraint and stack frames. Development and test keep the message for debugging. Extra
 * enumerable fields (pg `detail`, `where`, query parameters) are always dropped.
 */
export function errorSerializer(
  includeMessage: boolean,
): (err: unknown) => Record<string, unknown> {
  return (err) => {
    if (typeof err !== "object" || err === null) return { type: typeof err };
    const e = err as ErrorLike;
    const out: Record<string, unknown> = { type: typeof e.name === "string" ? e.name : "Error" };
    if (typeof e.code === "string" || typeof e.code === "number") out.code = e.code;
    if (typeof e.constraint === "string") out.constraint = e.constraint;
    if (includeMessage && typeof e.message === "string") out.message = e.message;
    if (typeof e.stack === "string") {
      const frames = e.stack.split("\n").filter((line) => line.trimStart().startsWith("at "));
      out.stack = frames.join("\n");
    }
    return out;
  };
}

/**
 * JSON lines on stdout (no transports, no worker threads), ISO timestamps, string levels.
 * `destination` replaces stdout, e.g. to capture lines in tests.
 */
export function createLogger(
  config: Pick<Config, "logLevel" | "env">,
  destination?: DestinationStream,
): Logger {
  const serializeError = errorSerializer(config.env !== "production");
  const options = {
    level: config.logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    serializers: { err: serializeError, error: serializeError },
    redact: { paths: redactPaths(), censor: "[redacted]" },
  };
  return destination ? pino(options, destination) : pino(options);
}
