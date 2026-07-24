/**
 * Pure helpers / invariants for Stage K2 (no network).
 * Run: node --experimental-strip-types apps/web/scripts/k2-notion-invariants.mts
 * or from apps/web with tsx if available.
 */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// Inline mirrors of critical rules so this script stays runnable without RR aliases.
function normalizeShopDomain(shop: string | null | undefined): string {
  if (typeof shop !== "string") return "";
  const normalized = shop.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized) ? normalized : "";
}

function buildShipmentKey(shopId: string, siNumber: string): string {
  const shop = normalizeShopDomain(shopId);
  const si = typeof siNumber === "string" ? siNumber.trim() : "";
  if (!shop || !si) throw new Error("required");
  return createHash("sha256").update(`${shop}\n${si}`, "utf8").digest("hex");
}

function shouldSkipUpload(
  existing: { kind: string; sha256: string } | null,
  next: { kind: string; sha256: string },
): boolean {
  if (!existing) return false;
  return existing.kind === next.kind && existing.sha256 === next.sha256;
}

const shopA = "alpha.myshopify.com";
const shopB = "beta.myshopify.com";
const si = "SN-100";

const keyA = buildShipmentKey(shopA, si);
const keyB = buildShipmentKey(shopB, si);
assert.notEqual(keyA, keyB, "shop boundary must change Shipment Key");
assert.equal(buildShipmentKey(shopA, si), keyA, "deterministic");
assert.equal(buildShipmentKey(` ${shopA.toUpperCase()} `, ` ${si} `), keyA, "normalize");

assert.equal(
  shouldSkipUpload({ kind: "packing_list", sha256: "abc" }, { kind: "packing_list", sha256: "abc" }),
  true,
);
assert.equal(
  shouldSkipUpload({ kind: "packing_list", sha256: "abc" }, { kind: "packing_list", sha256: "def" }),
  false,
);

// Spoof body shop must not equal session shop key material when domains differ
assert.notEqual(
  buildShipmentKey("evil.myshopify.com", si),
  buildShipmentKey(shopA, si),
);

console.log("k2-notion-invariants: ok");
