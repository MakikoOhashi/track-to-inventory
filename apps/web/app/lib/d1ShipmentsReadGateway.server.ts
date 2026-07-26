import { createHash } from "node:crypto";
import { getOptionalTtiDb } from "~/lib/cloudflareBindings.server";
import {
  classifyD1Error,
  createShipmentsRepository,
} from "~/lib/d1/index.server";
import type { SupabaseCompatibleShipment } from "~/lib/d1/shipments.server";
import { isD1ShipmentsReadEnabledForShop } from "~/lib/d1ShipmentsMode.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

export type ShipmentsReadOperation = "list" | "get" | "count";
export type ShipmentsReadSource = "supabase" | "d1" | "supabase_fallback";

type SupabaseReads = {
  list(shopId: string): Promise<SupabaseCompatibleShipment[]>;
  get(
    shopId: string,
    id: string,
  ): Promise<SupabaseCompatibleShipment | undefined>;
  count(shopId: string): Promise<number>;
};

type D1Reads = SupabaseReads;

export type ShipmentsReadGatewayDependencies = {
  isD1ReadEnabledForShop?: (shopId: string) => boolean;
  supabase?: SupabaseReads;
  d1?: D1Reads;
  log?: (entry: Record<string, unknown>) => void;
};

function safeShopId(shopId: string): string {
  return createHash("sha256").update(shopId).digest("hex").slice(0, 12);
}

function defaultSupabaseReads(): SupabaseReads {
  return {
    async list(shopId) {
      const { data, error } = await createSupabaseAdminClient()
        .from("shipments")
        .select("*")
        .eq("shop_id", shopId)
        .order("si_number", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SupabaseCompatibleShipment[];
    },
    async get(shopId, id) {
      const { data, error } = await createSupabaseAdminClient()
        .from("shipments")
        .select("*")
        .eq("shop_id", shopId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? undefined) as SupabaseCompatibleShipment | undefined;
    },
    async count(shopId) {
      const { count, error } = await createSupabaseAdminClient()
        .from("shipments")
        .select("*", { count: "exact", head: true })
        .eq("shop_id", shopId);
      if (error) throw error;
      return count ?? 0;
    },
  };
}

function defaultD1Reads(): D1Reads {
  function repo() {
    const db = getOptionalTtiDb();
    if (!db) throw new Error("TTI_DB binding missing");
    return createShipmentsRepository(db);
  }
  return {
    list: (shopId) => repo().listByShop(shopId),
    get: (shopId, id) => repo().getById(shopId, id),
    count: (shopId) => repo().countByShop(shopId),
  };
}

export function createShipmentsReadGateway(
  dependencies: ShipmentsReadGatewayDependencies = {},
) {
  const supabase = dependencies.supabase ?? defaultSupabaseReads();
  const d1 = dependencies.d1 ?? defaultD1Reads();
  const isD1ReadEnabledForShop =
    dependencies.isD1ReadEnabledForShop ??
    ((shopId) => isD1ShipmentsReadEnabledForShop(shopId));
  const log =
    dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));

  async function read<T>(
    operation: ShipmentsReadOperation,
    shopId: string,
    d1Read: () => Promise<T>,
    supabaseRead: () => Promise<T>,
  ): Promise<{ data: T; source: ShipmentsReadSource }> {
    const shop = normalizeShopDomain(shopId);
    if (!shop) throw new Error("Invalid shop_id");
    const startedAt = Date.now();
    const complete = (data: T, source: ShipmentsReadSource) => {
      log({
        type: "shipments_read_source",
        shop_id: safeShopId(shop),
        operation,
        source,
        duration_ms: Date.now() - startedAt,
      });
      return { data, source };
    };
    if (!isD1ReadEnabledForShop(shop)) {
      return complete(await supabaseRead(), "supabase");
    }
    try {
      return complete(await d1Read(), "d1");
    } catch (error) {
      const classified = classifyD1Error(error);
      log({
        type: "shipments_d1_read_fallback",
        shop_id: safeShopId(shop),
        operation,
        error_class: classified.classification,
      });
      return complete(await supabaseRead(), "supabase_fallback");
    }
  }

  return {
    list(shopId: string) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) throw new Error("Invalid shop_id");
      return read(
        "list",
        shop,
        () => d1.list(shop),
        () => supabase.list(shop),
      );
    },
    get(shopId: string, id: string) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) throw new Error("Invalid shop_id");
      return read(
        "get",
        shop,
        () => d1.get(shop, id),
        () => supabase.get(shop, id),
      );
    },
    count(shopId: string) {
      const shop = normalizeShopDomain(shopId);
      if (!shop) throw new Error("Invalid shop_id");
      return read(
        "count",
        shop,
        () => d1.count(shop),
        () => supabase.count(shop),
      );
    },
  };
}

export const shipmentsReadGateway = createShipmentsReadGateway();
