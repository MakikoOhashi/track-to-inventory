import type { Session } from "@shopify/shopify-api";
import { createHash } from "node:crypto";

/** AUTH-2b canary is intentionally not configurable from a request or CLI arg. */
export const AUTH2B_CANARY_SHOP = "xn-edkuc877j9g5b.myshopify.com";
export const AUTH2B_CANARY_CONFIRMATION = "AUTH2B-EXCHANGE-XN-CONFIRM";

export type Auth2bCanaryRow = {
  id: string;
  shop: string;
  isOnline: boolean;
  tokenCiphertext: string | null;
  tokenExpiresAt: string | null;
  tokenFingerprint: string | null;
  tokenGeneration: number;
};

export type Auth2bCanaryDependencies = {
  inspectSchema: () => Promise<boolean>;
  inspect: () => Promise<{
    row: Auth2bCanaryRow | null;
    session?: Session;
  }>;
  migrateToExpiringToken: (params: {
    shop: string;
    nonExpiringOfflineAccessToken: string;
  }) => Promise<{ session: Session }>;
  storeSession: (session: Session) => Promise<boolean>;
  /** Optional durable lease used by the HTTP operator route. */
  acquireLock?: () => Promise<boolean>;
  releaseLock?: () => Promise<void>;
};

export type Auth2bCanaryResult = {
  type: string;
  mode: "dry-run" | "execute";
  target_shop: typeof AUTH2B_CANARY_SHOP;
  id_hash?: string;
  generation?: number;
  token_ciphertext_present?: boolean;
  token_expires_at_present?: boolean;
  token_fingerprint_present?: boolean;
  exchange_called?: boolean;
  stored?: boolean;
  error?: string;
};

let exchangeInFlight = false;

function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

function safeResult(
  result: Omit<Auth2bCanaryResult, "target_shop">,
): Auth2bCanaryResult {
  return { ...result, target_shop: AUTH2B_CANARY_SHOP };
}

function preflightResult(
  mode: "dry-run" | "execute",
  row: Auth2bCanaryRow,
): Auth2bCanaryResult {
  return safeResult({
    type: "auth2b_canary_eligible",
    mode,
    id_hash: hashId(row.id),
    generation: row.tokenGeneration,
    token_ciphertext_present: Boolean(row.tokenCiphertext),
    token_expires_at_present: Boolean(row.tokenExpiresAt),
    token_fingerprint_present: Boolean(row.tokenFingerprint),
    exchange_called: false,
    stored: false,
  });
}

/**
 * Run the fixed-shop canary. The default is a read-only dry-run. No caller
 * supplied shop is accepted, and the only write is the existing SessionStorage
 * store after the official Shopify migration API returns a Session.
 */
async function runAuth2bCanaryExchangeUnlocked(
  dependencies: Auth2bCanaryDependencies,
  options: { execute?: boolean } = {},
): Promise<Auth2bCanaryResult> {
  const mode = options.execute ? "execute" : "dry-run";
  if (!(await dependencies.inspectSchema())) {
    return safeResult({
      type: "auth2b_canary_rejected",
      mode,
      error: "operator_schema_not_ready",
    });
  }

  const inspected = await dependencies.inspect();
  const row = inspected.row;
  if (!row || !inspected.session) {
    return safeResult({
      type: "auth2b_canary_rejected",
      mode,
      error: "target_session_missing_or_invalid",
    });
  }
  if (
    row.shop !== AUTH2B_CANARY_SHOP ||
    inspected.session.shop !== AUTH2B_CANARY_SHOP
  ) {
    return safeResult({
      type: "auth2b_canary_rejected",
      mode,
      error: "fixed_target_mismatch",
    });
  }
  if (row.tokenGeneration !== 0) {
    return safeResult({
      type: "auth2b_canary_rejected",
      mode,
      id_hash: hashId(row.id),
      generation: row.tokenGeneration,
      error: "already_exchanged_or_generation_not_zero",
    });
  }
  if (
    row.isOnline ||
    row.tokenCiphertext ||
    row.tokenExpiresAt ||
    row.tokenFingerprint ||
    inspected.session.isOnline ||
    inspected.session.expires ||
    inspected.session.refreshToken ||
    !inspected.session.accessToken
  ) {
    return safeResult({
      type: "auth2b_canary_rejected",
      mode,
      id_hash: hashId(row.id),
      generation: row.tokenGeneration,
      error: "session_is_not_generation_zero_legacy_offline",
    });
  }

  if (!options.execute) return preflightResult(mode, row);

  try {
    const migrated = await dependencies.migrateToExpiringToken({
      shop: AUTH2B_CANARY_SHOP,
      nonExpiringOfflineAccessToken: inspected.session.accessToken,
    });
    if (!migrated.session || migrated.session.shop !== AUTH2B_CANARY_SHOP) {
      return safeResult({
        type: "auth2b_canary_exchange_rejected",
        mode,
        id_hash: hashId(row.id),
        generation: row.tokenGeneration,
        exchange_called: true,
        error: "exchange_returned_wrong_shop_or_no_session",
      });
    }
    const stored = await dependencies.storeSession(migrated.session);
    if (!stored) {
      return safeResult({
        type: "auth2b_canary_store_failed_after_exchange",
        mode,
        id_hash: hashId(row.id),
        generation: row.tokenGeneration,
        exchange_called: true,
        stored: false,
        error: "session_storage_rejected",
      });
    }
    return safeResult({
      type: "auth2b_canary_exchange_stored",
      mode,
      id_hash: hashId(row.id),
      generation: row.tokenGeneration,
      exchange_called: true,
      stored: true,
    });
  } catch {
    // Never return Shopify's error body: it can contain request/token details.
    return safeResult({
      type: "auth2b_canary_exchange_failed",
      mode,
      id_hash: hashId(row.id),
      generation: row.tokenGeneration,
      exchange_called: true,
      stored: false,
      error: "official_token_exchange_failed",
    });
  }
}

export async function runAuth2bCanaryExchange(
  dependencies: Auth2bCanaryDependencies,
  options: { execute?: boolean } = {},
): Promise<Auth2bCanaryResult> {
  const execute = Boolean(options.execute);
  const mode = execute ? "execute" : "dry-run";
  if (execute) {
    if (exchangeInFlight) {
      return safeResult({
        type: "auth2b_canary_rejected",
        mode,
        error: "exchange_already_running",
      });
    }
    exchangeInFlight = true;
  }
  let durableLock = false;
  try {
    if (execute && dependencies.acquireLock) {
      durableLock = await dependencies.acquireLock();
      if (!durableLock) {
        return safeResult({
          type: "auth2b_canary_rejected",
          mode,
          error: "exchange_already_locked",
        });
      }
    }
    return await runAuth2bCanaryExchangeUnlocked(dependencies, options);
  } finally {
    if (durableLock && dependencies.releaseLock) {
      await dependencies.releaseLock().catch(() => undefined);
    }
    if (execute) exchangeInFlight = false;
  }
}
