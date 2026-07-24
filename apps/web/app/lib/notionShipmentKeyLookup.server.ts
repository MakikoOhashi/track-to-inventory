import {
  findPagesByShipmentKey,
} from "~/lib/notionClient.server";

export type ShipmentKeyLookup =
  | { ok: true; pageId: string }
  | { ok: false; code: "NOT_FOUND" | "DUPLICATE_CONFLICT"; pageIds?: string[] };

/**
 * Notion has no composite UNIQUE — refuse auto-merge when duplicates exist.
 */
export async function resolveUniqueShipmentPage(params: {
  accessToken: string;
  dataSourceId: string;
  shipmentKey: string;
}): Promise<ShipmentKeyLookup> {
  const pages = await findPagesByShipmentKey(params);
  if (pages.length === 0) return { ok: false, code: "NOT_FOUND" };
  if (pages.length > 1) {
    return {
      ok: false,
      code: "DUPLICATE_CONFLICT",
      pageIds: pages.map((p) => p.id).filter(Boolean),
    };
  }
  return { ok: true, pageId: pages[0].id };
}
