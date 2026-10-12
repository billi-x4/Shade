import type { ApiKeyKind, Network } from "../contract/index.ts";
import { COPY } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import type { Db } from "../platform/db.ts";
import type { Mailer } from "../platform/mailer.ts";
import type { Background } from "./background.ts";

/**
 * Security notices to the merchant's sign-in email after sensitive desk changes. Sent after commit,
 * best-effort, and never with secrets: no tokens, keys, viewing keys or full addresses.
 */
export interface Notifier {
  addressChanged(merchantId: string, network: Network, stripped: boolean): void;
  keyIssued(merchantId: string, key: { kind: ApiKeyKind; network: Network; label: string }): void;
  viewingKeyAdded(
    merchantId: string,
    key: { network: Network; fingerprint: string; useKeyAddress: boolean },
  ): void;
}

export function createNotifier(deps: {
  db: Db;
  config: Config;
  mailer: Mailer;
  background: Background;
}): Notifier {
  const { db, config, mailer, background } = deps;
  const settingsUrl = (page: string) => `${config.appOrigin}/desk/settings/${page}`;

  const send = (task: string, merchantId: string, subject: string, lines: (string | null)[]) =>
    background.run(task, async () => {
      const [owner] = await db<{ email: string }>`
        select u.email from merchants m join "user" u on u.id = m.user_id where m.id = ${merchantId}`;
      if (!owner) return;
      const text = lines.filter((line) => line !== null).join("\n");
      await mailer.send({ to: owner.email, subject, text });
    });

  return {
    addressChanged(merchantId, network, stripped) {
      send("mail.address_changed", merchantId, "Your Shade receive address changed", [
        `The ${network} receive address on your Shade account was changed.`,
        stripped
          ? "Shade removed its transparent receiver, so payers can only pay it privately."
          : null,
        `New invoices, jars and name.shade tags on ${network} pay the new address.`,
        "",
        `If you did not do this, set the address you expect at ${settingsUrl("address")} and change your password.`,
      ]);
    },
    keyIssued(merchantId, key) {
      send("mail.key_issued", merchantId, "A new Shade API key was created", [
        `A ${key.kind} API key named "${key.label}" was created for ${key.network} on your Shade account.`,
        "Shade showed the key once. It is not in this email.",
        "",
        `If you did not create it, revoke it at ${settingsUrl("keys")} and change your password.`,
      ]);
    },
    viewingKeyAdded(merchantId, key) {
      send("mail.viewing_key_added", merchantId, "Hosted payment detection is on", [
        `A full viewing key for ${key.network} (fingerprint ${key.fingerprint}) was added to your Shade account.`,
        COPY.ufvkNotice,
        key.useKeyAddress
          ? `Your ${key.network} receive address is now this key's shielded address.`
          : null,
        "",
        `If you did not do this, remove it at ${settingsUrl("detection")} and change your password.`,
      ]);
    },
  };
}
