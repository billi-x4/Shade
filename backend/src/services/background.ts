import type { Logger } from "../platform/logger.ts";

/**
 * Post-commit side effects (webhook kicks, notification emails) run here: they never block or fail
 * the request that triggered them, and `idle()` lets shutdown (and tests) wait for them.
 */
export interface Background {
  run(task: string, fn: () => Promise<unknown>): void;
  idle(): Promise<void>;
}

export function createBackground(logger: Logger): Background {
  const pending = new Set<Promise<void>>();
  return {
    run(task, fn) {
      const promise = (async () => {
        try {
          await fn();
        } catch (err) {
          logger.error({ err, task }, "background task failed");
        }
      })();
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
