/**
 * TrackToInventory Redis key namespace (Stage K3.6).
 * All TTI keys live under `tti:`. Legacy keys are read-fallback only.
 *
 * Do NOT touch other apps: ruidaichan:*, wakarumade:*, tti-ruidaichan-*, etc.
 */

export const TTI_PREFIX = "tti";

/** Families owned by TTI (legacy → new). */
export const TTI_LEGACY_PREFIXES = [
  "invsync:",
  "notion:",
  "shopify:session:",
  "shopify:shop-sessions:",
  "plan:",
  "ai:",
  "ocr:",
  "delete:",
] as const;

export function isTtiLegacyKey(key: string): boolean {
  return TTI_LEGACY_PREFIXES.some((p) => key.startsWith(p));
}

export function isOtherAppKey(key: string): boolean {
  return (
    key.startsWith("ruidaichan:") ||
    key.startsWith("wakarumade:") ||
    key.startsWith("tti-") // e.g. tti-ruidaichan-count — not TTI app namespace
  );
}

// --- Inventory sync ledger ---

export function invsyncLedgerKey(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  idempotencyKey: string;
}): string {
  return [
    TTI_PREFIX,
    "invsync",
    "ledger",
    encodeURIComponent(params.shopId),
    encodeURIComponent(params.siNumber),
    params.itemKey,
    params.idempotencyKey,
  ].join(":");
}

export function invsyncLedgerKeyLegacy(params: {
  shopId: string;
  siNumber: string;
  itemKey: string;
  idempotencyKey: string;
}): string {
  return [
    "invsync:ledger",
    encodeURIComponent(params.shopId),
    encodeURIComponent(params.siNumber),
    params.itemKey,
    params.idempotencyKey,
  ].join(":");
}

export function invsyncSiIndexKey(shopId: string, siNumber: string): string {
  return [
    TTI_PREFIX,
    "invsync",
    "si",
    encodeURIComponent(shopId),
    encodeURIComponent(siNumber),
  ].join(":");
}

export function invsyncSiIndexKeyLegacy(shopId: string, siNumber: string): string {
  return `invsync:si:${encodeURIComponent(shopId)}:${encodeURIComponent(siNumber)}`;
}

// --- Notion ---

export function notionConnectionKey(shop: string): string {
  return `${TTI_PREFIX}:notion:connection:${shop}`;
}

export function notionConnectionKeyLegacy(shop: string): string {
  return `notion:connection:${shop}`;
}

export function notionOAuthStateKey(state: string): string {
  return `${TTI_PREFIX}:notion:oauth-state:${state}`;
}

export function notionOAuthStateKeyLegacy(state: string): string {
  return `notion:oauth-state:${state}`;
}

export function notionProvisionLockKey(shop: string): string {
  return `${TTI_PREFIX}:notion:provision-lock:${shop}`;
}

export function notionProvisionLockKeyLegacy(shop: string): string {
  return `notion:provision-lock:${shop}`;
}

// --- Shopify sessions ---

export function shopifySessionKey(sessionId: string): string {
  return `${TTI_PREFIX}:shopify:session:${sessionId}`;
}

export function shopifySessionKeyLegacy(sessionId: string): string {
  return `shopify:session:${sessionId}`;
}

export function shopifyShopSessionsKey(shop: string): string {
  return `${TTI_PREFIX}:shopify:shop-sessions:${shop}`;
}

export function shopifyShopSessionsKeyLegacy(shop: string): string {
  return `shopify:shop-sessions:${shop}`;
}

// --- Usage / plan ---

export function planKey(userId: string): string {
  return `${TTI_PREFIX}:plan:${userId}`;
}

export function planKeyLegacy(userId: string): string {
  return `plan:${userId}`;
}

export function aiUsageKey(userId: string, month: string): string {
  return `${TTI_PREFIX}:ai:${userId}:${month}`;
}

export function aiUsageKeyLegacy(userId: string, month: string): string {
  return `ai:${userId}:${month}`;
}

export function ocrUsageKey(userId: string, month: string): string {
  return `${TTI_PREFIX}:ocr:${userId}:${month}`;
}

export function ocrUsageKeyLegacy(userId: string, month: string): string {
  return `ocr:${userId}:${month}`;
}

export function deleteUsageKey(shopId: string, month: string): string {
  return `${TTI_PREFIX}:delete:${shopId}:${month}`;
}

export function deleteUsageKeyLegacy(shopId: string, month: string): string {
  return `delete:${shopId}:${month}`;
}

/**
 * Map a known legacy TTI key to its tti: equivalent.
 * Returns null if the key is not a recognized TTI legacy key.
 */
export function mapLegacyTtiKeyToNew(legacyKey: string): string | null {
  if (legacyKey.startsWith("tti:")) return legacyKey;

  if (legacyKey.startsWith("invsync:ledger:")) {
    return `${TTI_PREFIX}:${legacyKey}`; // tti:invsync:ledger:...
  }
  if (legacyKey.startsWith("invsync:si:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("notion:connection:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("notion:oauth-state:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("notion:provision-lock:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("shopify:session:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("shopify:shop-sessions:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("plan:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("ai:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("ocr:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  if (legacyKey.startsWith("delete:")) {
    return `${TTI_PREFIX}:${legacyKey}`;
  }
  return null;
}

/** Mask shop / SI / long hex for safe logs. */
export function maskRedisKey(key: string): string {
  return key
    .replace(/[a-z0-9][a-z0-9-]*\.myshopify\.com/gi, "<shop>")
    .replace(/Sk[0-9A-Za-z-]+/g, "<si>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/[0-9a-f]{32,}/gi, "<hex>");
}
