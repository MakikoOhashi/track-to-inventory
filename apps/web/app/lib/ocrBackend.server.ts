import { createClient } from "@supabase/supabase-js";
import { formidable } from "formidable";
import fs from "fs";
import { fromBuffer } from "pdf2pic";
import type {
  GetFileUrlsInput,
  GetFileUrlsResult,
  PdfToImageResult,
  UploadShipmentFileInput,
  UploadShipmentFileResult,
} from "@track-to-inventory/shared";

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
const OCR_API_BASE_URL = process.env.OCR_API_BASE_URL?.replace(/\/+$/, "");
const OCR_API_SHARED_SECRET = process.env.OCR_API_SHARED_SECRET;

function hasExternalOcrBackend() {
  return Boolean(OCR_API_BASE_URL);
}

function ensureExternalOcrConfig() {
  if (!OCR_API_BASE_URL) {
    throw new Error("OCR API base URL is not configured");
  }

  if (!OCR_API_SHARED_SECRET) {
    throw new Error("OCR API shared secret is not configured");
  }
}

function getOcrApiHeaders(headers?: HeadersInit) {
  return {
    ...(OCR_API_SHARED_SECRET ? { "x-ocr-api-key": OCR_API_SHARED_SECRET } : {}),
    ...headers,
  };
}

async function parseOcrApiError(response: Response, fallbackMessage: string) {
  try {
    const data = await response.json();
    if (typeof data?.error === "string") return data.error;
  } catch {
    // Ignore JSON parse errors and fall back to the default message.
  }

  return fallbackMessage;
}

async function postMultipartToOcrApi<T>(path: string, formData: FormData, fallbackMessage: string) {
  ensureExternalOcrConfig();

  const response = await fetch(`${OCR_API_BASE_URL}${path}`, {
    method: "POST",
    headers: getOcrApiHeaders(),
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await parseOcrApiError(response, fallbackMessage));
  }

  return (await response.json()) as T;
}

async function postJsonToOcrApi<T>(
  path: string,
  body: Record<string, unknown>,
  fallbackMessage: string,
) {
  ensureExternalOcrConfig();

  const response = await fetch(`${OCR_API_BASE_URL}${path}`, {
    method: "POST",
    headers: getOcrApiHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await parseOcrApiError(response, fallbackMessage));
  }

  return (await response.json()) as T;
}

function getSupabaseAdminClient() {
  return createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  );
}

function ensureSupabaseConfig() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase設定エラー");
  }
}

export function parseMultipartForm(request: Request): Promise<{ fields: any; files: any }> {
  return new Promise((resolve, reject) => {
    const form = formidable({ keepExtensions: true });
    form.parse(request as any, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export async function convertPdfToImage(request: Request): Promise<PdfToImageResult> {
  if (hasExternalOcrBackend()) {
    const formData = await request.formData();
    return postMultipartToOcrApi<PdfToImageResult>(
      "/pdf-to-image",
      formData,
      "PDF→画像変換に失敗しました",
    );
  }

  const { files } = await parseMultipartForm(request);
  const uploaded = files.file;
  const pdfFile = Array.isArray(uploaded) ? uploaded[0] : uploaded;

  if (!pdfFile || !pdfFile.filepath) {
    throw new Error("PDFファイルがアップロードされていません");
  }

  const pdfBuffer = fs.readFileSync(pdfFile.filepath);
  const convert = fromBuffer(pdfBuffer, {
    density: 200,
    format: "png",
    width: 1200,
    height: 1600,
    savePath: "./public/tmp",
  });

  const result = await convert(1);
  if (!result.path) {
    throw new Error("画像パスが取得できませんでした");
  }

  return { url: result.path.replace(/^.*\/public/, "") };
}

export async function uploadShipmentFile(
  input: UploadShipmentFileInput,
): Promise<UploadShipmentFileResult> {
  if (hasExternalOcrBackend()) {
    const formData = new FormData();
    formData.append("si_number", input.siNumber);
    formData.append("type", input.type);
    formData.append("file", input.file);

    return postMultipartToOcrApi<UploadShipmentFileResult>(
      "/shipment-files",
      formData,
      "ファイルアップロード中にエラーが発生しました",
    );
  }

  ensureSupabaseConfig();

  const { siNumber, type, file } = input;

  if (!siNumber || !type || !file) {
    throw new Error("必須フィールドが不足しています");
  }

  if (file.size === 0) {
    throw new Error("空のファイルはアップロードできません");
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `ファイルサイズは最大10MBまでです（現在のサイズ: ${(file.size / (1024 * 1024)).toFixed(1)}MB）`,
    );
  }

  const fileExt = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = file.type;
  if (!ALLOWED_EXTENSIONS.includes(fileExt) || !ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error("許可されていないファイル形式です");
  }

  if (/[\\/:*?"<>|]/.test(siNumber) || /[\\/:*?"<>|]/.test(type)) {
    throw new Error("不正なファイルパスです");
  }

  const filePath = `${siNumber}/${type}.${fileExt}`;
  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  const supabase = getSupabaseAdminClient();

  const { error: uploadError } = await supabase.storage
    .from("shipment-files")
    .upload(filePath, uint8Array, {
      upsert: true,
      contentType: mimeType,
    });

  if (uploadError) {
    throw new Error(`アップロードエラー: ${uploadError.message}`);
  }

  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from("shipment-files")
    .createSignedUrl(filePath, 7 * 24 * 60 * 60);

  if (signedUrlError || !signedUrlData?.signedUrl) {
    throw new Error(
      signedUrlError
        ? `署名付きURL生成エラー: ${signedUrlError.message}`
        : "署名付きURLが生成されませんでした",
    );
  }

  return {
    filePath,
    signedUrl: signedUrlData.signedUrl,
    message: "ファイルが正常にアップロードされました",
  };
}

export async function createSignedFileUrls(
  input: GetFileUrlsInput,
  shopId: string,
): Promise<GetFileUrlsResult> {
  if (hasExternalOcrBackend()) {
    return postJsonToOcrApi<GetFileUrlsResult>(
      "/shipment-files/signed-urls",
      {
        ...input,
        shopId,
      },
      "署名付きURL生成に失敗しました",
    );
  }

  ensureSupabaseConfig();

  const supabase = getSupabaseAdminClient();
  const paths = Array.isArray(input.filePaths) ? input.filePaths : [input.filePaths];
  if (!paths.length || paths.every((path) => !path)) {
    throw new Error("ファイルパスが指定されていません");
  }

  if (input.siNumber) {
    const { data, error } = await supabase
      .from("shipments")
      .select("shop_id")
      .eq("si_number", input.siNumber)
      .single();

    if (error) {
      throw new Error("データベースエラー");
    }

    if (!data) {
      throw new Error("ファイルが見つかりません");
    }

    if (data.shop_id !== shopId) {
      throw new Error("アクセス権限がありません");
    }
  }

  const signedUrls: Record<string, string> = {};
  const errors: string[] = [];

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

  return {
    signedUrls,
    signedUrl: paths.length === 1 && paths[0] ? signedUrls[paths[0]] : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}
