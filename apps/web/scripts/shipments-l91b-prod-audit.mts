/**
 * Stage L9.1b: read-only production Supabase shipments/items audit.
 *
 * Run: npm run audit:shipments:l91b
 */
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  collectUnknownItemKeys,
  parseItemQuantity,
  ShipmentItemValidationError,
} from "../app/lib/d1/shipmentItemsCompat.server.ts";
import {
  validateSupabaseItemsForBackfill,
  type SupabaseShipmentRow,
} from "../app/lib/d1/shipmentsBackfill.server.ts";

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

loadEnv(".env.local");
loadEnv("../../.env.local");

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!url || !key) {
  console.error(JSON.stringify({ error: "missing_supabase_env" }));
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

type ItemKeyStats = Record<string, number>;
type QuantityTypeStats = Record<string, number>;

function valueKind(v: unknown): string {
  if (v === null) return "null";
  if (v === "") return "empty_string";
  return typeof v;
}

async function main() {
  const { data: rows, error } = await sb.from("shipments").select("*");
  if (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  }

  const shipments = (rows ?? []) as SupabaseShipmentRow[];
  const itemKeyStats: ItemKeyStats = {};
  const quantityTypeStats: QuantityTypeStats = {};
  let totalItems = 0;
  let itemsWithSyncId = 0;
  let itemsWithoutSyncId = 0;
  let nullQuantity = 0;
  let emptyStringQuantity = 0;
  const duplicateBusinessKeys: Array<{
    shop_id: string;
    si_number: string;
    index: number;
    signature: string;
  }> = [];
  const validationErrors: Array<{
    shop_id: string;
    si_number: string;
    code: string;
    message: string;
    index?: number;
  }> = [];

  for (const row of shipments) {
    const items = Array.isArray(row.items) ? row.items : [];
    const seenSignatures = new Map<string, number>();

    items.forEach((item, index) => {
      totalItems += 1;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const k of Object.keys(item as object)) {
          itemKeyStats[k] = (itemKeyStats[k] ?? 0) + 1;
        }
      }

      const sync =
        typeof (item as { sync_item_id?: string })?.sync_item_id === "string" &&
        (item as { sync_item_id?: string }).sync_item_id!.trim();
      if (sync) itemsWithSyncId += 1;
      else itemsWithoutSyncId += 1;

      const q = (item as { quantity?: unknown })?.quantity;
      quantityTypeStats[valueKind(q)] = (quantityTypeStats[valueKind(q)] ?? 0) + 1;
      if (q === null) nullQuantity += 1;
      if (q === "") emptyStringQuantity += 1;

      try {
        parseItemQuantity(q, index);
      } catch (e) {
        if (e instanceof ShipmentItemValidationError) {
          validationErrors.push({
            shop_id: row.shop_id,
            si_number: row.si_number,
            code: e.code,
            message: e.message,
            index: e.index,
          });
        }
      }

      if (item && typeof item === "object" && !Array.isArray(item)) {
        const unknown = collectUnknownItemKeys(item as Record<string, unknown>);
        if (unknown.length > 0) {
          validationErrors.push({
            shop_id: row.shop_id,
            si_number: row.si_number,
            code: "UNKNOWN_ITEM_KEYS",
            message: unknown.join(", "),
            index,
          });
        }
      }

      const signature = JSON.stringify({
        name: (item as { name?: unknown })?.name ?? null,
        product_code: (item as { product_code?: unknown })?.product_code ?? null,
        quantity: q ?? null,
        unit_price: (item as { unit_price?: unknown })?.unit_price ?? null,
        variant_id: (item as { variant_id?: unknown })?.variant_id ?? null,
      });
      if (seenSignatures.has(signature)) {
        duplicateBusinessKeys.push({
          shop_id: row.shop_id,
          si_number: row.si_number,
          index,
          signature,
        });
      } else {
        seenSignatures.set(signature, index);
      }
    });

    const validated = validateSupabaseItemsForBackfill({ row });
    if (!validated.ok) {
      validationErrors.push({
        shop_id: row.shop_id,
        si_number: row.si_number,
        code:
          validated.error instanceof ShipmentItemValidationError
            ? validated.error.code
            : "VALIDATION_ERROR",
        message: validated.error.message,
        index:
          validated.error instanceof ShipmentItemValidationError
            ? validated.error.index
            : undefined,
      });
    }
  }

  const backfillReady = validationErrors.length === 0;

  console.log(
    JSON.stringify(
      {
        type: "shipments_l91b_prod_audit",
        scannedAt: new Date().toISOString(),
        shipmentCount: shipments.length,
        totalItems,
        itemsWithSyncId,
        itemsWithoutSyncId,
        itemKeyStats,
        quantityTypeStats,
        nullQuantity,
        emptyStringQuantity,
        duplicateBusinessKeysCount: duplicateBusinessKeys.length,
        duplicateBusinessKeys,
        validationErrors,
        backfillReady,
        l92Gate: backfillReady ? "PASS_DRY_RUN" : "BLOCKED",
      },
      null,
      2,
    ),
  );

  if (!backfillReady) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
