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
export type { InventorySyncLedgerRepository, InventorySyncLedgerListRow } from "./inventorySyncLedger.server";
export {
  createShopifySessionRepository,
  serializeSessionPayload,
  deserializeSessionPayload,
} from "./shopifySessions.server";
export type { ShopifySessionRepository } from "./shopifySessions.server";
export {
  PLAN_LIMITS,
  limitFor,
  normalizeUserPlan,
  utcPeriodYm,
} from "./planLimits.server";
export type { UserPlan, UsageKind } from "./planLimits.server";
export { createShopPlanRepository } from "./shopPlans.server";
export type { ShopPlanRepository, ShopPlanRow } from "./shopPlans.server";
export { createUsageQuotaRepository } from "./usageQuota.server";
export type {
  UsageQuotaRepository,
  ReserveUsageResult,
  RefundUsageResult,
  UsageSnapshot,
} from "./usageQuota.server";
export {
  createNotionConnectionRepository,
  createNotionOAuthStateRepository,
  createNotionProvisionLockRepository,
} from "./notionMetadata.server";
export type {
  NotionConnectionRecord,
  NotionConnectionRepository,
  NotionConnectionStatus,
  NotionOAuthStateRecord,
  NotionOAuthStateRepository,
  NotionProvisionLockRecord,
  NotionProvisionLockRepository,
  ProvisionLockAcquireResult,
} from "./notionMetadata.server";
export {
  createShipmentsRepository,
  normalizeShipmentForCompare,
  ShipmentDuplicateError,
} from "./shipments.server";
export type {
  ShipmentCreateInput,
  ShipmentUpdateInput,
  ShipmentsRepository,
  SupabaseCompatibleShipment,
} from "./shipments.server";
export {
  d1RowsToSupabaseItems,
  supabaseItemsToD1Rows,
  buildDeterministicItemId,
  fingerprintD1ItemRows,
  parseItemQuantity,
  ShipmentItemValidationError,
  KNOWN_SUPABASE_ITEM_KEYS,
} from "./shipmentItemsCompat.server";
export type {
  D1ShipmentItemRow,
  SupabaseItemsParseOptions,
} from "./shipmentItemsCompat.server";
export {
  mirrorDeleteAllShipmentsOnD1,
  mirrorDeleteShipmentOnD1,
  mirrorSupabaseRowToD1,
  supabaseRowToRepoInput,
  validateSupabaseItemsForBackfill,
  withBackfillUpsert,
} from "./shipmentsBackfill.server";
export type {
  BackfillUpsertResult,
  ShipmentsBackfillRepository,
  SupabaseShipmentRow,
} from "./shipmentsBackfill.server";
