import type { ErrorCode } from "../contract/index.ts";

/**
 * An error with a stable wire shape. The HTTP error handler turns it into
 * `{ error: code, message, request_id, ...extra }` with `status`.
 * `message` is shown to API callers, so it must never carry secrets or echo input.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, code: ErrorCode, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
