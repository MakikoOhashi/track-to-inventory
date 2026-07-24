/**
 * D1 repository surface (Stage L1).
 * Intentionally unused by routes/actions — L2+ will connect gradually.
 */

export { requireTtiDb, D1_MIGRATION_VERSION, nowIso, D1ConfigError } from "./client.server";
export {
  classifyD1Error,
  D1RepositoryError,
  isRetryableD1Error,
} from "./errors.server";
export type {
  D1ErrorClass,
} from "./errors.server";
export type {
  FinalizeResult,
  InventorySyncLedgerRow,
  LedgerClaimAction,
  LedgerClaimResult,
  LedgerStatus,
  ShopifySessionPayload,
  ShopifySessionRow,
} from "./types.server";
export {
  createInventorySyncLedgerRepository,
  mapLedgerRow,
} from "./inventorySyncLedger.server";
export type { InventorySyncLedgerRepository } from "./inventorySyncLedger.server";
export {
  createShopifySessionRepository,
  serializeSessionPayload,
  deserializeSessionPayload,
} from "./shopifySessions.server";
export type { ShopifySessionRepository } from "./shopifySessions.server";
