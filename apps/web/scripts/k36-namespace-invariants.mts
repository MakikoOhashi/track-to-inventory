/**
 * Stage K3.6 key builder invariants (no network).
 */
import assert from "node:assert/strict";

const TTI_PREFIX = "tti";

function invsyncLedgerKey(params: {
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

function mapLegacy(legacyKey: string): string | null {
  if (legacyKey.startsWith("tti:")) return legacyKey;
  const ok = [
    "invsync:",
    "notion:",
    "shopify:session:",
    "shopify:shop-sessions:",
    "plan:",
    "ai:",
    "ocr:",
    "delete:",
  ].some((p) => legacyKey.startsWith(p));
  return ok ? `tti:${legacyKey}` : null;
}

const shopA = "alpha.myshopify.com";
const shopB = "beta.myshopify.com";
const keyA = invsyncLedgerKey({
  shopId: shopA,
  siNumber: "SI-1",
  itemKey: "item",
  idempotencyKey: "idem",
});
const keyB = invsyncLedgerKey({
  shopId: shopB,
  siNumber: "SI-1",
  itemKey: "item",
  idempotencyKey: "idem",
});
assert.notEqual(keyA, keyB);
assert.ok(keyA.startsWith("tti:invsync:ledger:"));
assert.equal(
  mapLegacy("invsync:ledger:x:y:z:w"),
  "tti:invsync:ledger:x:y:z:w",
);
assert.equal(mapLegacy("ruidaichan:free:count:1"), null);
assert.equal(mapLegacy("wakarumade:limit:x"), null);
assert.equal(mapLegacy("tti-ruidaichan-count"), null);

console.log("k36-namespace-invariants: ok");
