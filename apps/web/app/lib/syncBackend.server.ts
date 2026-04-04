import { data as json } from "react-router";

const SYNC_API_BASE_URL = process.env.SYNC_API_BASE_URL?.replace(/\/+$/, "");
const SYNC_API_SHARED_SECRET = process.env.SYNC_API_SHARED_SECRET;
const OCR_API_SHARED_SECRET = process.env.OCR_API_SHARED_SECRET;
const SYNC_API_TIMEOUT_MS = 20000;

function getSyncApiHeaders(headers?: HeadersInit) {
  return {
    ...(SYNC_API_SHARED_SECRET ? { "x-sync-api-key": SYNC_API_SHARED_SECRET } : {}),
    ...(OCR_API_SHARED_SECRET ? { "x-ocr-api-key": OCR_API_SHARED_SECRET } : {}),
    ...headers,
  };
}

async function parseSyncApiError(response: Response, fallbackMessage: string) {
  try {
    const data = await response.json();
    if (typeof data?.error === "string") return data.error;
  } catch {
    // Ignore JSON parse errors and fall back to the default message.
  }

  return fallbackMessage;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = SYNC_API_TIMEOUT_MS): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function isExternalSyncConfigured() {
  return Boolean(SYNC_API_BASE_URL);
}

export async function proxySyncStockRequest(request: Request) {
  if (!SYNC_API_BASE_URL) {
    throw new Error("SYNC API base URL is not configured");
  }

  const url = new URL(request.url);
  const targetUrl = new URL(`${SYNC_API_BASE_URL}/api/sync-stock`);

  const shopId = url.searchParams.get("shop_id");
  if (shopId) {
    targetUrl.searchParams.set("shop_id", shopId);
  }

  console.log("proxySyncStockRequest start", {
    targetUrl: targetUrl.toString(),
    shopId,
    method: request.method,
    hasSyncSecret: Boolean(SYNC_API_SHARED_SECRET),
    hasOcrSecret: Boolean(OCR_API_SHARED_SECRET),
  });

  const body = await withTimeout(request.text(), "sync proxy request.text");
  console.log("proxySyncStockRequest body read", {
    bodyLength: body.length,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("sync proxy fetch timed out")), SYNC_API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: getSyncApiHeaders({
        "Content-Type": request.headers.get("content-type") ?? "application/json",
      }),
      body,
      signal: controller.signal,
    });
  } catch (error) {
    console.error("proxySyncStockRequest fetch failed", error);
    return json(
      {
        error: error instanceof Error ? error.message : "External sync API request failed",
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  console.log("proxySyncStockRequest fetch completed", {
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    const errorMessage = await parseSyncApiError(response, "External sync API request failed");
    return json({ error: errorMessage }, { status: response.status });
  }

  const data = await withTimeout(response.json(), "sync proxy response.json");
  console.log("proxySyncStockRequest response parsed", {
    keys: data && typeof data === "object" ? Object.keys(data) : [],
  });
  return json(data);
}
