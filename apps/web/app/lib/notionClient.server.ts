export const NOTION_VERSION = "2025-09-03";

export class NotionApiError extends Error {
  status: number;
  code: string;
  retryAfter: number | null;

  constructor(status: number, message: string, code = "NOTION_API", retryAfter: number | null = null) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function notionHeaders(accessToken: string, contentType?: string): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Notion-Version": NOTION_VERSION,
  };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

export async function notionFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const url = path.startsWith("http") ? path : `https://api.notion.com/v1${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...notionHeaders(
        accessToken,
        init.body && !(init.body instanceof FormData) ? "application/json" : undefined,
      ),
      ...(init.headers || {}),
    },
  });

  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : null;
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    const message =
      (typeof json?.message === "string" && json.message) ||
      `Notion API ${response.status}`;
    // Never include Authorization or token material
    throw new NotionApiError(
      response.status,
      message,
      json?.code || "NOTION_API",
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }

  return json;
}

export async function notionSearch(
  accessToken: string,
  query: string,
  filter?: { property: string; value: string },
): Promise<any[]> {
  const body: Record<string, unknown> = {
    query,
    page_size: 50,
  };
  if (filter) body.filter = filter;
  const data = await notionFetch(accessToken, "/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return Array.isArray(data?.results) ? data.results : [];
}

export async function createShipmentsDatabase(params: {
  accessToken: string;
  parentPageId: string;
  title: string;
  properties: Record<string, unknown>;
}): Promise<{ databaseId: string; dataSourceId: string | null; raw: any }> {
  const payload = {
    parent: { type: "page_id", page_id: params.parentPageId },
    title: [{ type: "text", text: { content: params.title } }],
    initial_data_source: {
      properties: params.properties,
    },
  };

  const raw = await notionFetch(params.accessToken, "/databases", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const databaseId = raw?.id as string;
  const dataSourceId =
    (Array.isArray(raw?.data_sources) && raw.data_sources[0]?.id) ||
    raw?.initial_data_source?.id ||
    null;

  return { databaseId, dataSourceId, raw };
}

export async function retrieveDatabase(
  accessToken: string,
  databaseId: string,
): Promise<any> {
  return notionFetch(accessToken, `/databases/${databaseId}`);
}

export async function retrieveDataSource(
  accessToken: string,
  dataSourceId: string,
): Promise<any> {
  return notionFetch(accessToken, `/data_sources/${dataSourceId}`);
}

export async function patchDataSourceProperties(
  accessToken: string,
  dataSourceId: string,
  properties: Record<string, unknown>,
): Promise<any> {
  return notionFetch(accessToken, `/data_sources/${dataSourceId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

export async function createPageInDataSource(params: {
  accessToken: string;
  dataSourceId: string;
  properties: Record<string, unknown>;
}): Promise<any> {
  return notionFetch(params.accessToken, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: params.dataSourceId },
      properties: params.properties,
    }),
  });
}

export async function updatePageProperties(params: {
  accessToken: string;
  pageId: string;
  properties: Record<string, unknown>;
}): Promise<any> {
  return notionFetch(params.accessToken, `/pages/${params.pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: params.properties }),
  });
}

export async function retrievePage(
  accessToken: string,
  pageId: string,
): Promise<any> {
  return notionFetch(accessToken, `/pages/${pageId}`);
}

export async function archivePage(
  accessToken: string,
  pageId: string,
): Promise<any> {
  return notionFetch(accessToken, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}

/** Query data source for exact Shipment Key match. */
export async function findPagesByShipmentKey(params: {
  accessToken: string;
  dataSourceId: string;
  shipmentKey: string;
}): Promise<any[]> {
  const body = {
    filter: {
      property: "Shipment Key",
      rich_text: { equals: params.shipmentKey },
    },
    page_size: 10,
  };

  try {
    const data = await notionFetch(
      params.accessToken,
      `/data_sources/${params.dataSourceId}/query`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return Array.isArray(data?.results) ? data.results : [];
  } catch (error) {
    if (error instanceof NotionApiError && error.status === 404) {
      const data = await notionFetch(
        params.accessToken,
        `/databases/${params.dataSourceId}/query`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return Array.isArray(data?.results) ? data.results : [];
    }
    throw error;
  }
}
