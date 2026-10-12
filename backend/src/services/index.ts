import type { Network } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import type { Db } from "../platform/db.ts";
import type { Logger } from "../platform/logger.ts";
import type { Mailer } from "../platform/mailer.ts";
import type { ChainClient } from "../zcash/lightwalletd.ts";
import type { Scanner } from "../zcash/scanner.ts";
import { createBackground } from "./background.ts";
import { type ConfigService, createConfigService } from "./config.ts";
import { type GrantService, createGrantService } from "./grants.ts";
import { type InvoiceService, createInvoiceService, createInvoiceView } from "./invoices.ts";
import { type JarService, createJarService } from "./jars.ts";
import { type KeyService, createKeyService } from "./keys.ts";
import { type MerchantService, createMerchantService } from "./merchants.ts";
import { createNotifier } from "./notifications.ts";
import { type SettlementService, createSettlementService } from "./settlement.ts";
import { type TagService, createTagService } from "./tags.ts";
import { type ViewingKeyService, createViewingKeyService } from "./viewing-keys.ts";
import { type WebhookService, createWebhookService } from "./webhooks.ts";

export interface ServiceDeps {
  db: Db;
  config: Config;
  logger: Logger;
  chain: Record<Network, ChainClient>;
  scanner: Scanner;
  mailer: Mailer;
  /** Business time, passed into SQL as a parameter. */
  clock: () => Date;
}

export interface Services {
  merchants: MerchantService;
  invoices: InvoiceService;
  settlement: SettlementService;
  jars: JarService;
  grants: GrantService;
  webhooks: WebhookService;
  tags: TagService;
  keys: KeyService;
  viewingKeys: ViewingKeyService;
  config: ConfigService;
  /** The same clock the services use (rate-limit windows and fresh-session checks share it). */
  clock: () => Date;
  /** Resolves once post-commit work (webhook kicks, notification emails) has finished. */
  idle(): Promise<void>;
}

export function createServices(deps: ServiceDeps): Services {
  const { db, config, logger, chain, scanner, mailer, clock } = deps;
  const background = createBackground(logger.child({ component: "services" }));
  const appConfig = createConfigService({ config, scanner });
  const notifier = createNotifier({ db, config, mailer, background });
  const view = createInvoiceView(config, clock);
  const webhooks = createWebhookService({ db, config, logger, clock, background });

  return {
    merchants: createMerchantService({ db, config, clock, appConfig, notifier }),
    invoices: createInvoiceService({ db, config, logger, chain, clock, view }),
    settlement: createSettlementService({ db, config, chain, clock, view, webhooks }),
    jars: createJarService({ db, config, clock, view }),
    grants: createGrantService({ db, config, clock }),
    webhooks,
    tags: createTagService({ db, config, clock }),
    keys: createKeyService({ db, config, logger, clock, notifier }),
    viewingKeys: createViewingKeyService({ db, config, scanner, clock, appConfig, notifier }),
    config: appConfig,
    clock,
    idle: () => background.idle(),
  };
}
