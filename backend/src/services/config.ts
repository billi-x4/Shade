import type { AppConfig } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import type { Scanner } from "../zcash/scanner.ts";

export interface ConfigService {
  /** GET /api/config: what the web app needs to render forms and links. */
  appConfig(): Promise<AppConfig>;
  /**
   * Hosted detection needs the worker's seal public key (so the API can seal uploaded viewing keys)
   * and a scanner that loads on this platform.
   */
  hostedDetection(): Promise<boolean>;
}

export function createConfigService(deps: { config: Config; scanner: Scanner }): ConfigService {
  const { config, scanner } = deps;
  let hosted: Promise<boolean> | null = null;

  const hostedDetection = (): Promise<boolean> => {
    if (config.sealPublicKey === null) return Promise.resolve(false);
    hosted ??= scanner.available().catch(() => false);
    return hosted;
  };

  return {
    hostedDetection,
    async appConfig() {
      return {
        networks: [...config.networks],
        default_network: config.defaultNetwork,
        min_confirmations: { ...config.minConfirmations },
        auth: {
          email_password: true,
          email_verification_required: config.requireEmailVerification,
          password_min_length: config.passwordMinLength,
        },
        features: { hosted_detection: await hostedDetection() },
        explorer_tx_url: { ...config.explorerTxUrl },
      };
    },
  };
}
