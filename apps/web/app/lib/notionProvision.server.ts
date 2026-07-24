import {
  acquireProvisionLock,
  getNotionAccessToken,
  getNotionConnection,
  releaseProvisionLock,
  saveNotionConnection,
  TTI_SHIPMENTS_DB_TITLE,
  type NotionConnectionRecord,
} from "~/lib/notionConnection.server";
import {
  createShipmentsDatabase,
  NotionApiError,
  retrieveDataSource,
  retrieveDatabase,
  notionSearch,
  patchDataSourceProperties,
} from "~/lib/notionClient.server";
import {
  buildInitialDataSourceProperties,
  SHIPMENTS_SCHEMA_PROPERTIES,
  SHIPMENTS_SCHEMA_VERSION,
  validateShipmentsSchema,
  type SchemaValidationIssue,
} from "~/lib/notionShipmentsSchema.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

export type ProvisionResult =
  | {
      ok: true;
      action: "created" | "reused" | "patched";
      databaseId: string;
      dataSourceId: string | null;
      schemaVersion: number;
      addedProperties?: string[];
    }
  | {
      ok: false;
      code:
        | "NOT_CONNECTED"
        | "LOCK_BUSY"
        | "MISSING_PARENT"
        | "DUPLICATE_DATABASES"
        | "SCHEMA_MISMATCH"
        | "NOTION_ERROR"
        | "INVALID_SHOP";
      message: string;
      details?: unknown;
    };

function databaseTitlePlain(db: any): string {
  const title = db?.title;
  if (!Array.isArray(title)) return "";
  return title.map((t: any) => t?.plain_text || "").join("").trim();
}

async function findTtiShipmentsDatabases(accessToken: string): Promise<any[]> {
  const results = await notionSearch(accessToken, TTI_SHIPMENTS_DB_TITLE, {
    property: "object",
    value: "database",
  });
  return results.filter(
    (r) => r?.object === "database" && databaseTitlePlain(r) === TTI_SHIPMENTS_DB_TITLE,
  );
}

async function resolveDataSourceId(
  accessToken: string,
  databaseId: string,
  preferred: string | null,
): Promise<string | null> {
  if (preferred) return preferred;
  const db = await retrieveDatabase(accessToken, databaseId);
  const fromList =
    (Array.isArray(db?.data_sources) && db.data_sources[0]?.id) || null;
  return fromList;
}

async function loadSchemaProperties(
  accessToken: string,
  databaseId: string,
  dataSourceId: string | null,
): Promise<{ properties: Record<string, any>; dataSourceId: string | null }> {
  if (dataSourceId) {
    try {
      const ds = await retrieveDataSource(accessToken, dataSourceId);
      if (ds?.properties) {
        return { properties: ds.properties, dataSourceId };
      }
    } catch (error) {
      if (!(error instanceof NotionApiError && error.status === 404)) throw error;
    }
  }

  const db = await retrieveDatabase(accessToken, databaseId);
  const resolvedDs =
    dataSourceId ||
    (Array.isArray(db?.data_sources) && db.data_sources[0]?.id) ||
    null;

  if (resolvedDs && !db?.properties) {
    const ds = await retrieveDataSource(accessToken, resolvedDs);
    return { properties: ds?.properties || {}, dataSourceId: resolvedDs };
  }

  return { properties: db?.properties || {}, dataSourceId: resolvedDs };
}

function buildMissingPropertyPatches(
  properties: Record<string, any>,
): Record<string, unknown> {
  const initial = buildInitialDataSourceProperties();
  const patches: Record<string, unknown> = {};
  for (const spec of SHIPMENTS_SCHEMA_PROPERTIES) {
    if (!properties?.[spec.name]) {
      patches[spec.name] = initial[spec.name];
    }
  }
  return patches;
}

async function persistProvisionSuccess(
  conn: NotionConnectionRecord,
  params: {
    parentPageId: string | null;
    databaseId: string;
    dataSourceId: string | null;
  },
): Promise<NotionConnectionRecord> {
  const now = new Date().toISOString();
  const next: NotionConnectionRecord = {
    ...conn,
    parent_page_id: params.parentPageId ?? conn.parent_page_id,
    shipments_database_id: params.databaseId,
    shipments_data_source_id: params.dataSourceId,
    schema_version: SHIPMENTS_SCHEMA_VERSION,
    status: "provisioned",
    last_error: null,
    updated_at: now,
  };
  await saveNotionConnection(next);
  return next;
}

async function persistProvisionError(
  conn: NotionConnectionRecord | null,
  message: string,
): Promise<void> {
  if (!conn) return;
  await saveNotionConnection({
    ...conn,
    status: "error",
    last_error: message.slice(0, 500),
    updated_at: new Date().toISOString(),
  });
}

/**
 * Idempotent Shipments DB provision for one shop.
 * Never deletes/renames existing properties. May add missing required ones.
 */
export async function provisionShipmentsDatabase(params: {
  shopId: string;
  parentPageId?: string | null;
  allowAddMissingProperties?: boolean;
}): Promise<ProvisionResult> {
  const shop = normalizeShopDomain(params.shopId);
  if (!shop) {
    return { ok: false, code: "INVALID_SHOP", message: "Invalid shop" };
  }

  const locked = await acquireProvisionLock(shop);
  if (!locked) {
    return {
      ok: false,
      code: "LOCK_BUSY",
      message: "Provisioning already in progress for this shop",
    };
  }

  try {
    const conn = await getNotionConnection(shop);
    if (!conn || conn.status === "revoked") {
      return { ok: false, code: "NOT_CONNECTED", message: "Notion is not connected" };
    }

    const accessToken = await getNotionAccessToken(shop);
    if (!accessToken) {
      await persistProvisionError(conn, "Unable to decrypt Notion token");
      return {
        ok: false,
        code: "NOT_CONNECTED",
        message: "Notion token unavailable",
      };
    }

    const parentPageId =
      (typeof params.parentPageId === "string" && params.parentPageId.trim()) ||
      conn.parent_page_id;

    // Prefer already-bound database
    if (conn.shipments_database_id) {
      try {
        const dataSourceId = await resolveDataSourceId(
          accessToken,
          conn.shipments_database_id,
          conn.shipments_data_source_id,
        );
        const { properties, dataSourceId: resolvedDs } = await loadSchemaProperties(
          accessToken,
          conn.shipments_database_id,
          dataSourceId,
        );
        const validation = validateShipmentsSchema(properties);
        if (!validation.ok) {
          if (
            params.allowAddMissingProperties !== false &&
            validation.missing.length > 0 &&
            validation.issues.length === 0 &&
            resolvedDs
          ) {
            const patches = buildMissingPropertyPatches(properties);
            const added = Object.keys(patches);
            await patchDataSourceProperties(accessToken, resolvedDs, patches);
            const reloaded = await loadSchemaProperties(
              accessToken,
              conn.shipments_database_id,
              resolvedDs,
            );
            const recheck = validateShipmentsSchema(reloaded.properties);
            if (!recheck.ok) {
              await persistProvisionError(
                conn,
                `Schema mismatch after patch: missing=${recheck.missing.join(",")} issues=${recheck.issues.length}`,
              );
              return {
                ok: false,
                code: "SCHEMA_MISMATCH",
                message: "Schema still invalid after adding missing properties",
                details: recheck,
              };
            }
            await persistProvisionSuccess(conn, {
              parentPageId: parentPageId || null,
              databaseId: conn.shipments_database_id,
              dataSourceId: resolvedDs,
            });
            return {
              ok: true,
              action: "patched",
              databaseId: conn.shipments_database_id,
              dataSourceId: resolvedDs,
              schemaVersion: SHIPMENTS_SCHEMA_VERSION,
              addedProperties: added,
            };
          }

          await persistProvisionError(
            conn,
            `Schema mismatch: missing=${validation.missing.join(",")}`,
          );
          return {
            ok: false,
            code: "SCHEMA_MISMATCH",
            message: "Existing bound database schema does not match",
            details: validation,
          };
        }

        await persistProvisionSuccess(conn, {
          parentPageId: parentPageId || null,
          databaseId: conn.shipments_database_id,
          dataSourceId: resolvedDs,
        });
        return {
          ok: true,
          action: "reused",
          databaseId: conn.shipments_database_id,
          dataSourceId: resolvedDs,
          schemaVersion: SHIPMENTS_SCHEMA_VERSION,
        };
      } catch (error) {
        const message =
          error instanceof NotionApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Failed to retrieve bound database";
        await persistProvisionError(conn, message);
        return {
          ok: false,
          code: "NOTION_ERROR",
          message,
          details:
            error instanceof NotionApiError
              ? { status: error.status, code: error.code, retryAfter: error.retryAfter }
              : undefined,
        };
      }
    }

    let matches: any[];
    try {
      matches = await findTtiShipmentsDatabases(accessToken);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Notion search failed";
      await persistProvisionError(conn, message);
      return {
        ok: false,
        code: "NOTION_ERROR",
        message,
        details:
          error instanceof NotionApiError
            ? { status: error.status, retryAfter: error.retryAfter }
            : undefined,
      };
    }

    if (matches.length > 1) {
      const message = `Found ${matches.length} "${TTI_SHIPMENTS_DB_TITLE}" databases; refuse to auto-select`;
      await persistProvisionError(conn, message);
      return {
        ok: false,
        code: "DUPLICATE_DATABASES",
        message,
        details: { ids: matches.map((m) => m.id) },
      };
    }

    if (matches.length === 1) {
      const databaseId = matches[0].id as string;
      const dataSourceId = await resolveDataSourceId(accessToken, databaseId, null);
      const { properties, dataSourceId: resolvedDs } = await loadSchemaProperties(
        accessToken,
        databaseId,
        dataSourceId,
      );
      const validation = validateShipmentsSchema(properties);

      if (!validation.ok) {
        if (
          params.allowAddMissingProperties !== false &&
          validation.missing.length > 0 &&
          validation.issues.length === 0 &&
          resolvedDs
        ) {
          const patches = buildMissingPropertyPatches(properties);
          const added = Object.keys(patches);
          await patchDataSourceProperties(accessToken, resolvedDs, patches);
          const reloaded = await loadSchemaProperties(accessToken, databaseId, resolvedDs);
          const recheck = validateShipmentsSchema(reloaded.properties);
          if (!recheck.ok) {
            await persistProvisionError(conn, "Schema mismatch after patch");
            return {
              ok: false,
              code: "SCHEMA_MISMATCH",
              message: "Schema still invalid after adding missing properties",
              details: recheck,
            };
          }
          await persistProvisionSuccess(conn, {
            parentPageId: parentPageId || null,
            databaseId,
            dataSourceId: resolvedDs,
          });
          return {
            ok: true,
            action: "patched",
            databaseId,
            dataSourceId: resolvedDs,
            schemaVersion: SHIPMENTS_SCHEMA_VERSION,
            addedProperties: added,
          };
        }

        await persistProvisionError(conn, "Schema mismatch on existing DB");
        return {
          ok: false,
          code: "SCHEMA_MISMATCH",
          message: "Existing TTI Shipments database schema does not match",
          details: validation as { ok: false; issues: SchemaValidationIssue[]; missing: string[] },
        };
      }

      await persistProvisionSuccess(conn, {
        parentPageId: parentPageId || null,
        databaseId,
        dataSourceId: resolvedDs,
      });
      return {
        ok: true,
        action: "reused",
        databaseId,
        dataSourceId: resolvedDs,
        schemaVersion: SHIPMENTS_SCHEMA_VERSION,
      };
    }

    // Create new
    if (!parentPageId) {
      return {
        ok: false,
        code: "MISSING_PARENT",
        message: "Select a Notion parent page before creating the Shipments database",
      };
    }

    try {
      const created = await createShipmentsDatabase({
        accessToken,
        parentPageId,
        title: TTI_SHIPMENTS_DB_TITLE,
        properties: buildInitialDataSourceProperties(),
      });

      const { properties, dataSourceId } = await loadSchemaProperties(
        accessToken,
        created.databaseId,
        created.dataSourceId,
      );
      const validation = validateShipmentsSchema(properties);
      if (!validation.ok) {
        await persistProvisionError(
          conn,
          `Created DB failed validation: missing=${validation.missing.join(",")}`,
        );
        return {
          ok: false,
          code: "SCHEMA_MISMATCH",
          message: "Created database failed schema validation",
          details: validation,
        };
      }

      await persistProvisionSuccess(conn, {
        parentPageId,
        databaseId: created.databaseId,
        dataSourceId,
      });
      return {
        ok: true,
        action: "created",
        databaseId: created.databaseId,
        dataSourceId,
        schemaVersion: SHIPMENTS_SCHEMA_VERSION,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create database";
      await persistProvisionError(conn, message);
      return {
        ok: false,
        code: "NOTION_ERROR",
        message,
        details:
          error instanceof NotionApiError
            ? { status: error.status, code: error.code, retryAfter: error.retryAfter }
            : undefined,
      };
    }
  } finally {
    await releaseProvisionLock(shop);
  }
}

/** List pages the integration can see (for parent selection). */
export async function listNotionParentPages(shopId: string): Promise<
  | { ok: true; pages: Array<{ id: string; title: string }> }
  | { ok: false; code: string; message: string }
> {
  const shop = normalizeShopDomain(shopId);
  if (!shop) return { ok: false, code: "INVALID_SHOP", message: "Invalid shop" };
  const accessToken = await getNotionAccessToken(shop);
  if (!accessToken) {
    return { ok: false, code: "NOT_CONNECTED", message: "Notion is not connected" };
  }

  try {
    const results = await notionSearch(accessToken, "", {
      property: "object",
      value: "page",
    });
    const pages = results
      .filter((r) => r?.object === "page")
      .map((r) => {
        const props = r?.properties || {};
        let title = "";
        for (const value of Object.values(props) as any[]) {
          if (value?.type === "title" && Array.isArray(value.title)) {
            title = value.title.map((t: any) => t?.plain_text || "").join("");
            break;
          }
        }
        if (!title && Array.isArray(r?.title)) {
          title = r.title.map((t: any) => t?.plain_text || "").join("");
        }
        return { id: r.id as string, title: title || "(untitled)" };
      });
    return { ok: true, pages };
  } catch (error) {
    return {
      ok: false,
      code: "NOTION_ERROR",
      message: error instanceof Error ? error.message : "Failed to list pages",
    };
  }
}
