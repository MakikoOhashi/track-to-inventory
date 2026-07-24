import { createHash } from "node:crypto";
import {
  archivePage,
  createPageInDataSource,
  NotionApiError,
  notionFetch,
  retrievePage,
  updatePageProperties,
} from "~/lib/notionClient.server";
import { getNotionAccessToken, getNotionConnection } from "~/lib/notionConnection.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

/**
 * K5-oriented file replace interface (design only for K2).
 * Supabase shipment Storage paths are unchanged.
 */
export type DocumentFileKind =
  | "packing_list"
  | "commercial_invoice"
  | "si_document"
  | "other";

export const DOCUMENT_KIND_TO_PROPERTY: Record<DocumentFileKind, string> = {
  packing_list: "Packing List",
  commercial_invoice: "Commercial Invoice",
  si_document: "SI Document",
  other: "Other Documents",
};

export type FileContentMeta = {
  kind: DocumentFileKind;
  filename: string;
  size: number;
  contentType: string;
  sha256: string;
  notionFileUploadId?: string;
  attachedAt?: string;
};

export type ReplaceDocumentFilePlan = {
  /** Skip upload when sha256 matches existing meta for this kind */
  skipIfChecksumMatch: true;
  /** After successful attach, replace Files property with the new file only */
  replacePropertyFiles: true;
  /** Never persist Notion temporary download URLs */
  persistTemporaryUrls: false;
};

export const DEFAULT_REPLACE_DOCUMENT_FILE_PLAN: ReplaceDocumentFilePlan = {
  skipIfChecksumMatch: true,
  replacePropertyFiles: true,
  persistTemporaryUrls: false,
};

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function shouldSkipUpload(
  existing: FileContentMeta | null | undefined,
  next: Pick<FileContentMeta, "kind" | "sha256">,
): boolean {
  if (!existing) return false;
  return existing.kind === next.kind && existing.sha256 === next.sha256;
}

/** Tiny 1x1 PNG for isolated smoke tests. */
export const SMOKE_PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

export type FileUploadSmokeResult =
  | {
      ok: true;
      pageId: string;
      fileUploadId: string;
      filename: string;
      size: number;
      contentType: string;
      sha256: string;
      retrieved: {
        name: string | null;
        // Intentionally omit temporary URLs from response
        hasFile: boolean;
      };
      cleanedUp: boolean;
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: unknown;
    };

async function createFileUploadObject(
  accessToken: string,
  filename: string,
  contentType: string,
): Promise<{ id: string; upload_url?: string; status?: string }> {
  return notionFetch(accessToken, "/file_uploads", {
    method: "POST",
    body: JSON.stringify({
      mode: "single_part",
      filename,
      content_type: contentType,
    }),
  });
}

async function sendFileUpload(
  accessToken: string,
  fileUploadId: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<any> {
  const form = new FormData();
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  form.append("file", new Blob([ab], { type: contentType }), filename);

  // Do not set Content-Type manually — boundary must be automatic
  const response = await fetch(
    `https://api.notion.com/v1/file_uploads/${fileUploadId}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": "2025-09-03",
      },
      body: form,
    },
  );

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new NotionApiError(
      response.status,
      (typeof json?.message === "string" && json.message) ||
        `File upload send failed (${response.status})`,
      json?.code || "NOTION_API",
    );
  }
  return json;
}

function extractFilesProperty(
  page: any,
  propertyName: string,
): Array<{ name?: string; type?: string; file?: { url?: string }; external?: { url?: string } }> {
  const prop = page?.properties?.[propertyName];
  if (!prop || prop.type !== "files" || !Array.isArray(prop.files)) return [];
  return prop.files;
}

/**
 * Isolated smoke: create test page → upload PNG → attach Packing List → retrieve → archive page.
 * Does not touch production shipments or Supabase Storage.
 */
export async function runNotionFileUploadSmoke(shopId: string): Promise<FileUploadSmokeResult> {
  const shop = normalizeShopDomain(shopId);
  if (!shop) {
    return { ok: false, code: "INVALID_SHOP", message: "Invalid shop" };
  }

  const conn = await getNotionConnection(shop);
  if (!conn?.shipments_database_id || !conn.shipments_data_source_id) {
    return {
      ok: false,
      code: "NOT_PROVISIONED",
      message: "Shipments database is not provisioned",
    };
  }

  const accessToken = await getNotionAccessToken(shop);
  if (!accessToken) {
    return { ok: false, code: "NOT_CONNECTED", message: "Notion token unavailable" };
  }

  const filename = `tti-smoke-${Date.now()}.png`;
  const contentType = "image/png";
  const bytes = SMOKE_PNG_BYTES;
  const digest = sha256Hex(Buffer.from(bytes));
  let pageId: string | null = null;

  try {
    const createdPage = await createPageInDataSource({
      accessToken,
      dataSourceId: conn.shipments_data_source_id,
      properties: {
        Name: {
          title: [{ type: "text", text: { content: `TTI smoke ${Date.now()}` } }],
        },
        "Shipment Key": {
          rich_text: [
            {
              type: "text",
              text: { content: `smoke-${shop}-${Date.now()}` },
            },
          ],
        },
        "Shop ID": {
          rich_text: [{ type: "text", text: { content: shop } }],
        },
        "SI Number": {
          rich_text: [{ type: "text", text: { content: `SMOKE-${Date.now()}` } }],
        },
        "Migration Status": { select: { name: "pending" } },
        "Latest Source": { select: { name: "manual" } },
        "Schema Version": { number: 1 },
      },
    });
    pageId = createdPage?.id;
    if (!pageId) {
      return { ok: false, code: "PAGE_CREATE_FAILED", message: "No page id returned" };
    }

    const uploadObj = await createFileUploadObject(accessToken, filename, contentType);
    if (!uploadObj?.id) {
      return { ok: false, code: "UPLOAD_CREATE_FAILED", message: "No file_upload id" };
    }

    await sendFileUpload(accessToken, uploadObj.id, filename, contentType, bytes);

    await updatePageProperties({
      accessToken,
      pageId,
      properties: {
        "Packing List": {
          files: [
            {
              type: "file_upload",
              file_upload: { id: uploadObj.id },
              name: filename,
            },
          ],
        },
      },
    });

    const page = await retrievePage(accessToken, pageId);
    const packing = extractFilesProperty(page, "Packing List");
    const invoice = extractFilesProperty(page, "Commercial Invoice");
    if (invoice.length > 0) {
      return {
        ok: false,
        code: "PROPERTY_MIXUP",
        message: "Commercial Invoice unexpectedly received files during Packing List smoke",
      };
    }

    const first = packing[0];
    // Strip any temporary URLs from what we return / would persist
    const retrievedName = first?.name || null;

    let cleanedUp = false;
    try {
      await archivePage(accessToken, pageId);
      cleanedUp = true;
    } catch {
      cleanedUp = false;
    }

    return {
      ok: true,
      pageId,
      fileUploadId: uploadObj.id,
      filename,
      size: bytes.byteLength,
      contentType,
      sha256: digest,
      retrieved: {
        name: retrievedName,
        hasFile: packing.length > 0,
      },
      cleanedUp,
    };
  } catch (error) {
    if (pageId) {
      try {
        await archivePage(accessToken, pageId);
      } catch {
        // ignore cleanup failure
      }
    }
    return {
      ok: false,
      code: error instanceof NotionApiError ? error.code : "NOTION_ERROR",
      message: error instanceof Error ? error.message : "File upload smoke failed",
      details:
        error instanceof NotionApiError
          ? { status: error.status, retryAfter: error.retryAfter }
          : undefined,
    };
  }
}
