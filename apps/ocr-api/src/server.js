import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createClient } from "@supabase/supabase-js";
import { fromBuffer } from "pdf2pic";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 4001);
const sharedSecret = process.env.OCR_API_SHARED_SECRET;

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
];

const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "pdf", "txt"];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function json(response, status = 200) {
  return new Response(JSON.stringify(response), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function ensureAuthorized(request) {
  if (!sharedSecret) return;

  const provided = request.headers.get("x-ocr-api-key");
  if (!provided || provided !== sharedSecret) {
    throw new HttpError(401, "OCR API authentication failed");
  }
}

function ensureSupabaseConfig() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(500, "Supabase設定エラー");
  }
}

function getSupabaseAdminClient() {
  ensureSupabaseConfig();

  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

async function convertIncomingMessageToRequest(req) {
  const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
  const url = new URL(req.url ?? "/", origin);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendNodeResponse(nodeResponse, response) {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  if (!response.body) {
    nodeResponse.end();
    return;
  }

  const arrayBuffer = await response.arrayBuffer();
  nodeResponse.end(Buffer.from(arrayBuffer));
}

async function handlePdfToImage(request) {
  const formData = await request.formData();
  const uploaded = formData.get("file");

  if (!(uploaded instanceof File)) {
    throw new HttpError(400, "PDFファイルがアップロードされていません");
  }

  const pdfBuffer = Buffer.from(await uploaded.arrayBuffer());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tti-pdf-"));

  try {
    const convert = fromBuffer(pdfBuffer, {
      density: 200,
      format: "png",
      width: 1200,
      height: 1600,
      savePath: tempDir,
      saveFilename: "preview",
    });

    const result = await convert(1);
    if (!result.path) {
      throw new HttpError(500, "画像パスが取得できませんでした");
    }

    const imageBuffer = await fs.readFile(result.path);
    return json({
      url: `data:image/png;base64,${imageBuffer.toString("base64")}`,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function handleShipmentFileUpload(request) {
  const formData = await request.formData();
  const siNumber = formData.get("si_number");
  const type = formData.get("type");
  const file = formData.get("file");

  if (typeof siNumber !== "string" || typeof type !== "string" || !(file instanceof File)) {
    throw new HttpError(400, "必須フィールドが不足しています");
  }

  if (file.size === 0) {
    throw new HttpError(400, "空のファイルはアップロードできません");
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new HttpError(
      400,
      `ファイルサイズは最大10MBまでです（現在のサイズ: ${(file.size / (1024 * 1024)).toFixed(1)}MB）`,
    );
  }

  const fileExt = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = file.type;

  if (!ALLOWED_EXTENSIONS.includes(fileExt) || !ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new HttpError(400, "許可されていないファイル形式です");
  }

  if (/[\\/:*?"<>|]/.test(siNumber) || /[\\/:*?"<>|]/.test(type)) {
    throw new HttpError(400, "不正なファイルパスです");
  }

  const filePath = `${siNumber}/${type}.${fileExt}`;
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const supabase = getSupabaseAdminClient();

  const { error: uploadError } = await supabase.storage
    .from("shipment-files")
    .upload(filePath, fileBytes, {
      upsert: true,
      contentType: mimeType,
    });

  if (uploadError) {
    throw new HttpError(500, `アップロードエラー: ${uploadError.message}`);
  }

  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from("shipment-files")
    .createSignedUrl(filePath, 7 * 24 * 60 * 60);

  if (signedUrlError || !signedUrlData?.signedUrl) {
    throw new HttpError(
      500,
      signedUrlError
        ? `署名付きURL生成エラー: ${signedUrlError.message}`
        : "署名付きURLが生成されませんでした",
    );
  }

  return json({
    filePath,
    signedUrl: signedUrlData.signedUrl,
    message: "ファイルが正常にアップロードされました",
  });
}

async function handleSignedUrlRequest(request) {
  const body = await request.json();
  const paths = Array.isArray(body.filePaths) ? body.filePaths : [body.filePaths];
  const shopId = body.shopId;

  if (typeof shopId !== "string" || !shopId) {
    throw new HttpError(401, "shop_idが必要です");
  }

  if (!paths.length || paths.every((filePath) => !filePath)) {
    throw new HttpError(400, "ファイルパスが指定されていません");
  }

  const supabase = getSupabaseAdminClient();

  if (body.siNumber) {
    const { data, error } = await supabase
      .from("shipments")
      .select("shop_id")
      .eq("si_number", body.siNumber)
      .single();

    if (error) {
      throw new HttpError(500, "データベースエラー");
    }

    if (!data) {
      throw new HttpError(404, "ファイルが見つかりません");
    }

    if (data.shop_id !== shopId) {
      throw new HttpError(403, "アクセス権限がありません");
    }
  }

  const signedUrls = {};
  const errors = [];

  for (const filePath of paths) {
    if (!filePath) continue;

    if (/[\\:*?"<>|]/.test(filePath) || filePath.includes("..") || filePath.startsWith("/")) {
      errors.push(`不正なファイルパス: ${filePath}`);
      continue;
    }

    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("shipment-files")
      .createSignedUrl(filePath, 24 * 60 * 60);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      errors.push(
        `${filePath}: ${
          signedUrlError?.message ?? "署名付きURLが生成されませんでした"
        }`,
      );
      continue;
    }

    signedUrls[filePath] = signedUrlData.signedUrl;
  }

  return json({
    signedUrls,
    signedUrl: paths.length === 1 && paths[0] ? signedUrls[paths[0]] : undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
}

function getRouteHandler(method, pathname) {
  if (method === "GET" && pathname === "/health") {
    return async () =>
      json({
        ok: true,
        service: "ocr-api",
        requestId: randomUUID(),
      });
  }

  if (method === "POST" && pathname === "/pdf-to-image") {
    return handlePdfToImage;
  }

  if (method === "POST" && pathname === "/shipment-files") {
    return handleShipmentFileUpload;
  }

  if (method === "POST" && pathname === "/shipment-files/signed-urls") {
    return handleSignedUrlRequest;
  }

  return null;
}

const server = createServer(async (req, res) => {
  try {
    const request = await convertIncomingMessageToRequest(req);
    ensureAuthorized(request);

    const handler = getRouteHandler(request.method, new URL(request.url).pathname);
    if (!handler) {
      await sendNodeResponse(res, json({ error: "Not Found" }, 404));
      return;
    }

    const response = await handler(request);
    await sendNodeResponse(res, response);
  } catch (error) {
    console.error("OCR API error:", error);

    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "OCR APIで予期しないエラーが発生しました";

    await sendNodeResponse(
      res,
      json(
        {
          error: message,
        },
        status,
      ),
    );
  }
});

server.listen(port, host, () => {
  console.log(`OCR API listening on http://${host}:${port}`);
});
