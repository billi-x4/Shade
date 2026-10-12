/**
 * Minimal webhook receiver for the demo (PRD §12 step 3): verifies each delivery with verifyWebhook, dedupes by
 * event id and prints "<type> <invoice_id> <amount_zec> verification=<v>". It never prints memos or the secret.
 *
 *   SHADE_WEBHOOK_SECRET=whsec_… npm run demo:receiver -w @shade/backend -- [--port 8790] [--host 127.0.0.1]
 *
 * SHADE_WEBHOOK_SECRET is the whsec_… value shown once when the endpoint was created (backend/.env is loaded when
 * present). Getting deliveries here:
 *   - Local dev backend: start it with SHADE_WEBHOOK_ALLOW_PRIVATE=1 (allows http and loopback targets) and register
 *     http://127.0.0.1:8790/ as the endpoint URL.
 *   - Deployed Shade: deliveries only go to public https URLs on port 443 or 8443. Expose this receiver through a
 *     public HTTPS tunnel (for example `cloudflared tunnel --url http://127.0.0.1:8790`) and register the tunnel URL.
 *
 * Answers 200 for verified (and duplicate) events, 400 when verification fails.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { verifyWebhook, WebhookVerificationError } from "../src/index.ts";

const USAGE = `Usage: npm run demo:receiver -w @shade/backend -- [--port 8790] [--host 127.0.0.1]

Environment:
  SHADE_WEBHOOK_SECRET  whsec_… signing secret of the endpoint (required)`;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_REMEMBERED_EVENTS = 10_000;

class BodyTooLargeError extends Error {}

/** Buffers the exact request bytes. Past the cap it keeps draining (discarding) so the 413 reaches the sender. */
function readRawBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () =>
      size > MAX_BODY_BYTES ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks)),
    );
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseFlags(): { port: number; host: string } | string {
  let values: { port: string; host: string };
  try {
    values = parseArgs({
      options: {
        port: { type: "string", default: "8790" },
        host: { type: "string", default: "127.0.0.1" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    return "--port must be a number from 0 to 65535.";
  return { port, host: values.host };
}

function main(): void {
  const flags = parseFlags();
  const secret = process.env.SHADE_WEBHOOK_SECRET ?? "";
  if (typeof flags === "string" || secret === "") {
    console.error(
      `${typeof flags === "string" ? flags : "SHADE_WEBHOOK_SECRET is not set."}\n\n${USAGE}`,
    );
    process.exitCode = 2;
    return;
  }

  // Insertion-ordered, so the oldest ids are forgotten first once the cap is reached.
  const seen = new Set<string>();

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    readRawBody(req)
      .then(async (raw) => {
        const event = await verifyWebhook(raw, req.headers, secret);
        if (seen.has(event.id)) {
          console.log(`duplicate ${event.id} ignored`);
          reply(res, 200, { received: true, duplicate: true });
          return;
        }
        seen.add(event.id);
        if (seen.size > MAX_REMEMBERED_EVENTS) seen.delete(seen.values().next().value!);
        const verification = event.verification ?? "-";
        console.log(
          `${event.type} ${event.invoiceId ?? "-"} ${event.amountZec ?? "-"} verification=${verification}`,
        );
        reply(res, 200, { received: true });
      })
      .catch((err: unknown) => {
        if (err instanceof WebhookVerificationError) {
          console.error(`rejected · ${err.reason}`);
          reply(res, 400, { error: err.reason });
        } else if (err instanceof BodyTooLargeError) {
          reply(res, 413, { error: "body_too_large" });
        } else {
          console.error(`error · ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) reply(res, 500, { error: "internal" });
        }
      });
  });

  server.listen(flags.port, flags.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : flags.port;
    const host = flags.host.includes(":") ? `[${flags.host}]` : flags.host;
    console.log(`listening on http://${host}:${port}`);
  });

  const stop = (): void => {
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main();
