import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Delivery failed. Carries the provider's HTTP status only, never the request or response body. */
export class MailError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super(status === null ? "mail delivery failed" : `mail delivery failed (HTTP ${status})`);
    this.name = "MailError";
    this.status = status;
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

/**
 * Console transport: development and test log the subject and link-bearing text so sign-up works
 * without a provider; production logs only that a message was dropped (config refuses console
 * delivery when verification is required). Resend transport: one HTTPS POST per message.
 */
export function createMailer(config: Config, logger: Logger): Mailer {
  const log = logger.child({ component: "mailer" });

  if (config.mail.transport === "console") {
    const exposeContent = config.env !== "production";
    return {
      async send(msg) {
        if (exposeContent) {
          log.info(
            { mail: { to: msg.to, subject: msg.subject, text: msg.text } },
            "mail (console)",
          );
        } else {
          log.warn({ mail: { subject: msg.subject } }, "mail not delivered: console transport");
        }
      },
    };
  }

  const apiKey = config.mail.resendApiKey;
  if (!apiKey) throw new Error("RESEND_API_KEY is required for the resend mail transport");
  return {
    async send(msg) {
      let response: Response;
      try {
        response = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: config.mail.from,
            to: [msg.to],
            subject: msg.subject,
            text: msg.text,
            ...(msg.html === undefined ? {} : { html: msg.html }),
          }),
          signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
        });
      } catch (err) {
        log.error({ err }, "mail delivery failed: provider unreachable");
        throw new MailError(null);
      }
      await response.body?.cancel();
      if (!response.ok) {
        log.error({ mail: { status: response.status } }, "mail delivery failed");
        throw new MailError(response.status);
      }
    },
  };
}
