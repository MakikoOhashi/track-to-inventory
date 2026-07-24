/**
 * TrackToInventory Shipments Notion schema (per-shop user-owned DB).
 *
 * NOTE: TODO K2 listed "Latest Source: files" — that conflicts with Stage K design
 * (source is an enum). Implemented as select. Reported in Stage K2 completion.
 *
 * Shipment fields vs schema:
 * - Covered: si_number, shop_id, status, supplier_name, eta, items, file columns,
 *   etd, delayed, transport_type, memo, clearance_date, arrival_date, is_archived
 * - Items stay JSON (not relation). rich_text hard limit ~2000 chars — see ITEMS_JSON_MAX.
 */

export const SHIPMENTS_SCHEMA_VERSION = 1;
export const ITEMS_JSON_MAX_CHARS = 1900; // leave margin under Notion ~2000 rich_text limit

export type NotionPropertyType =
  | "title"
  | "rich_text"
  | "select"
  | "date"
  | "files"
  | "number"
  | "checkbox";

export type SchemaPropertySpec = {
  name: string;
  type: NotionPropertyType;
  selectOptions?: string[];
  required: boolean;
};

const STATUS_OPTIONS = [
  "SI発行済",
  "siIssued",
  "scheduleConfirmed",
  "shipping",
  "customsClearance",
  "warehouseArrival",
  "synced",
  "other",
];

const MIGRATION_STATUS_OPTIONS = [
  "pending",
  "mirrored",
  "verified",
  "conflict",
  "duplicate_conflict",
];

const LATEST_SOURCE_OPTIONS = ["app", "migration", "manual"];

/** Ordered required + shipment-aligned properties. */
export const SHIPMENTS_SCHEMA_PROPERTIES: SchemaPropertySpec[] = [
  { name: "Name", type: "title", required: true },
  { name: "Shipment Key", type: "rich_text", required: true },
  { name: "Shop ID", type: "rich_text", required: true },
  { name: "SI Number", type: "rich_text", required: true },
  { name: "Status", type: "select", selectOptions: STATUS_OPTIONS, required: true },
  { name: "Supplier", type: "rich_text", required: true },
  { name: "ETA", type: "date", required: true },
  { name: "ETD", type: "date", required: true },
  { name: "Transport Type", type: "rich_text", required: true },
  { name: "Memo", type: "rich_text", required: true },
  { name: "Clearance Date", type: "date", required: true },
  { name: "Arrival Date", type: "date", required: true },
  { name: "Delayed", type: "checkbox", required: true },
  { name: "Archived", type: "checkbox", required: true },
  { name: "Items JSON", type: "rich_text", required: true },
  { name: "Packing List", type: "files", required: true },
  { name: "Commercial Invoice", type: "files", required: true },
  { name: "SI Document", type: "files", required: true },
  { name: "Other Documents", type: "files", required: true },
  {
    name: "Latest Source",
    type: "select",
    selectOptions: LATEST_SOURCE_OPTIONS,
    required: true,
  },
  { name: "Updated At", type: "date", required: true },
  {
    name: "Migration Status",
    type: "select",
    selectOptions: MIGRATION_STATUS_OPTIONS,
    required: true,
  },
  { name: "Schema Version", type: "number", required: true },
];

export function buildInitialDataSourceProperties(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const spec of SHIPMENTS_SCHEMA_PROPERTIES) {
    switch (spec.type) {
      case "title":
        props[spec.name] = { title: {} };
        break;
      case "rich_text":
        props[spec.name] = { rich_text: {} };
        break;
      case "date":
        props[spec.name] = { date: {} };
        break;
      case "files":
        props[spec.name] = { files: {} };
        break;
      case "number":
        props[spec.name] = { number: { format: "number" } };
        break;
      case "checkbox":
        props[spec.name] = { checkbox: {} };
        break;
      case "select":
        props[spec.name] = {
          select: {
            options: (spec.selectOptions || []).map((name) => ({ name })),
          },
        };
        break;
    }
  }
  return props;
}

export type SchemaValidationIssue = {
  property: string;
  expected: string;
  actual: string;
};

export function validateShipmentsSchema(properties: Record<string, any>): {
  ok: boolean;
  issues: SchemaValidationIssue[];
  missing: string[];
} {
  const issues: SchemaValidationIssue[] = [];
  const missing: string[] = [];

  for (const spec of SHIPMENTS_SCHEMA_PROPERTIES) {
    const prop = properties?.[spec.name];
    if (!prop) {
      missing.push(spec.name);
      continue;
    }
    const actualType = prop.type as string;
    if (actualType !== spec.type) {
      issues.push({
        property: spec.name,
        expected: spec.type,
        actual: actualType || "unknown",
      });
    }
  }

  return {
    ok: missing.length === 0 && issues.length === 0,
    issues,
    missing,
  };
}

export function assertItemsJsonFits(json: string): void {
  if (json.length > ITEMS_JSON_MAX_CHARS) {
    throw new Error(
      `Items JSON exceeds Notion rich_text safe limit (${ITEMS_JSON_MAX_CHARS}). Use page body storage (not implemented in K2).`,
    );
  }
}
