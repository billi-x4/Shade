import { describe, expect, it, vi } from "vitest";
import { api, ApiError, errorMessage, path, withQuery } from "@/api/client";
import { mockFetch } from "@/test/utils";

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("api client", () => {
  it("sends same-origin JSON and parses the response", async () => {
    const { calls } = mockFetch([
      { method: "POST", path: "/api/desk/jars", status: 201, body: { id: "jar_1" } },
    ]);
    const result = await api.post<{ id: string }>("/api/desk/jars", {
      cap_zec: "0.006",
      label: "agent",
    });
    expect(result).toEqual({ id: "jar_1" });
    const call = calls[0];
    expect(call?.init?.credentials).toBe("same-origin");
    expect((call?.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(call?.body).toEqual({ cap_zec: "0.006", label: "agent" });
  });

  it("sends bodiless POSTs without a content type", async () => {
    const { calls } = mockFetch([
      { method: "POST", path: "/api/desk/jars/jar_1/kill", body: { id: "jar_1" } },
    ]);
    await api.post("/api/desk/jars/jar_1/kill");
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("maps a contract error body to ApiError with every field", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/v1/jars/jar_1/charge",
        status: 402,
        body: {
          error: "JAR_EMPTY",
          message: "Jar empty. The agent cannot spend.",
          request_id: "req_9",
          remaining_zec: "0",
        },
      },
    ]);
    const error = await caught(api.post("/v1/jars/jar_1/charge", { amount_zec: "0.002" }));
    expect(error.status).toBe(402);
    expect(error.code).toBe("JAR_EMPTY");
    expect(error.message).toBe("Jar empty. The agent cannot spend.");
    expect(error.requestId).toBe("req_9");
    expect(error.remainingZec).toBe("0");
  });

  it("reads retry_after from the body or the retry-after header", async () => {
    mockFetch([
      {
        path: "/api/public/invoices/inv_1",
        status: 429,
        body: { error: "RATE_LIMITED", message: "Slow down." },
        headers: { "retry-after": "12", "x-request-id": "req_h" },
      },
    ]);
    const error = await caught(api.get("/api/public/invoices/inv_1"));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfter).toBe(12);
    expect(error.requestId).toBe("req_h");
    expect(errorMessage(error)).toBe("Too many tries. Wait 12 seconds and try again.");
  });

  it("keeps only path and message from validation issues", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/desk/invoices",
        status: 400,
        body: {
          error: "INVALID_REQUEST",
          message: "Check the highlighted fields.",
          issues: [{ path: "amount_zec", message: "Required", value: "leak" }, "junk"],
        },
      },
    ]);
    const error = await caught(api.post("/api/desk/invoices", {}));
    expect(error.issues).toEqual([{ path: "amount_zec", message: "Required" }]);
    expect(errorMessage(error)).toBe("Check the highlighted fields. Required");
  });

  it("falls back by status when the body is not a Shade error", async () => {
    mockFetch([
      {
        path: "/api/desk/me",
        status: 401,
        body: "<html>nope</html>",
        headers: { "content-type": "text/html" },
      },
      {
        path: "/api/desk/jars",
        status: 502,
        body: "<html>bad gateway</html>",
        headers: { "content-type": "text/html" },
      },
      { path: "/api/desk/tags", status: 400, body: { error: "MADE_UP", message: "x" } },
    ]);
    expect((await caught(api.get("/api/desk/me"))).code).toBe("UNAUTHORIZED");
    const gateway = await caught(api.get("/api/desk/jars"));
    expect(gateway.code).toBe("UNEXPECTED_RESPONSE");
    expect(gateway.status).toBe(502);
    expect((await caught(api.get("/api/desk/tags"))).code).toBe("UNEXPECTED_RESPONSE");
  });

  it("turns a failed fetch into NETWORK_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const error = await caught(api.get("/api/config"));
    expect(error.status).toBe(0);
    expect(error.code).toBe("NETWORK_ERROR");
  });

  it("rethrows aborts untouched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    await expect(api.get("/api/config")).rejects.toBeInstanceOf(DOMException);
  });

  it("returns nothing for 204 deletes", async () => {
    mockFetch([{ method: "DELETE", path: "/api/desk/webhooks/whk_1", status: 204 }]);
    await expect(api.delete("/api/desk/webhooks/whk_1")).resolves.toBeUndefined();
  });

  it("flags a 2xx answer that is not JSON", async () => {
    mockFetch([
      { path: "/api/config", body: "<html></html>", headers: { "content-type": "text/html" } },
    ]);
    expect((await caught(api.get("/api/config"))).code).toBe("UNEXPECTED_RESPONSE");
  });

  it("encodes path segments and skips empty query values", () => {
    expect(path`/api/desk/jars/${"a/b?c"}/kill`).toBe("/api/desk/jars/a%2Fb%3Fc/kill");
    expect(withQuery("/api/desk/invoices", { status: "open", cursor: null, limit: "25" })).toBe(
      "/api/desk/invoices?status=open&limit=25",
    );
  });

  it("says long rate-limit waits in minutes or hours, not thousands of seconds", () => {
    const limited = (retryAfter: number | null) =>
      errorMessage(
        new ApiError({ status: 429, code: "RATE_LIMITED", message: "Slow down.", retryAfter }),
      );
    expect(limited(3_412)).toBe("Too many tries. Wait about 57 minutes and try again.");
    expect(limited(7_200)).toBe("Too many tries. Wait about 2 hours and try again.");
    expect(limited(1)).toBe("Too many tries. Wait 1 second and try again.");
    expect(limited(null)).toBe("Too many tries. Wait a moment and try again.");
  });

  it("gives a reference for internal errors", () => {
    const error = new ApiError({
      status: 500,
      code: "INTERNAL",
      message: "boom",
      requestId: "req_1",
    });
    expect(errorMessage(error)).toBe("Something went wrong on our side. Reference req_1.");
    expect(errorMessage(new Error("raw"))).toBe("Something went wrong. Try again.");
  });
});
