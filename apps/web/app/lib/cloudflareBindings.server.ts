/**
 * Request-scoped Cloudflare bindings (nodejs_compat AsyncLocalStorage).
 * Used so D1 can be read from syncLedger without threading Env through every call.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type CloudflareRequestStore = {
  env: Env;
  ctx: ExecutionContext;
};

const storage = new AsyncLocalStorage<CloudflareRequestStore>();

export function runWithCloudflareEnv<T>(
  store: CloudflareRequestStore,
  fn: () => T,
): T {
  return storage.run(store, fn);
}

export function getCloudflareEnv(): Env | undefined {
  return storage.getStore()?.env;
}

/** Best-effort D1 access; missing binding → undefined (shadow must no-op). */
export function getOptionalTtiDb(): D1Database | undefined {
  return storage.getStore()?.env?.TTI_DB;
}
