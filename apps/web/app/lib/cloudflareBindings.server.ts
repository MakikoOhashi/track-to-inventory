/**
 * Request-scoped Cloudflare bindings (nodejs_compat AsyncLocalStorage).
 * Used so D1 can be read from syncLedger / session shadow without threading Env.
 *
 * Worker entry (`workers/app.ts`) and the React Router server bundle are separate
 * modules — each would otherwise create its own AsyncLocalStorage and lose the
 * store across the boundary. Keep a single ALS on globalThis (not the binding).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type CloudflareRequestStore = {
  env: Env;
  ctx: ExecutionContext;
};

const ALS_GLOBAL_KEY = "__tti_cloudflare_request_als__";

type AlsGlobal = typeof globalThis & {
  [ALS_GLOBAL_KEY]?: AsyncLocalStorage<CloudflareRequestStore>;
};

function getRequestAls(): AsyncLocalStorage<CloudflareRequestStore> {
  const g = globalThis as AlsGlobal;
  if (!g[ALS_GLOBAL_KEY]) {
    g[ALS_GLOBAL_KEY] = new AsyncLocalStorage<CloudflareRequestStore>();
  }
  return g[ALS_GLOBAL_KEY];
}

export function runWithCloudflareEnv<T>(
  store: CloudflareRequestStore,
  fn: () => T,
): T {
  return getRequestAls().run(store, fn);
}

export function getCloudflareEnv(): Env | undefined {
  return getRequestAls().getStore()?.env;
}

export function getCloudflareCtx(): ExecutionContext | undefined {
  return getRequestAls().getStore()?.ctx;
}

/** Best-effort D1 access; missing binding → undefined (shadow must no-op). */
export function getOptionalTtiDb(): D1Database | undefined {
  return getRequestAls().getStore()?.env?.TTI_DB;
}
