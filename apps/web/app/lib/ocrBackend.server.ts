import type {
  GetFileUrlsInput,
  GetFileUrlsResult,
  OcrTextResult,
  PdfToImageResult,
  UploadShipmentFileInput,
  UploadShipmentFileResult,
} from "@track-to-inventory/shared";

const OCR_API_BASE_URL = process.env.OCR_API_BASE_URL?.replace(/\/+$/, "");
const OCR_API_SHARED_SECRET = process.env.OCR_API_SHARED_SECRET;

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

export async function convertPdfToImage(request: Request): Promise<PdfToImageResult> {
  const formData = await request.formData();
  return postMultipartToOcrApi<PdfToImageResult>(
    "/pdf-to-image",
    formData,
    "PDF→画像変換に失敗しました",
  );
}

export async function extractOcrText(file: File): Promise<OcrTextResult> {
  const formData = new FormData();
  formData.append("file", file);

  return postMultipartToOcrApi<OcrTextResult>(
    "/ocr-text",
    formData,
    "OCRに失敗しました",
  );
}

export async function uploadShipmentFile(
  input: UploadShipmentFileInput,
): Promise<UploadShipmentFileResult> {
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

export async function createSignedFileUrls(
  input: GetFileUrlsInput,
  shopId: string,
): Promise<GetFileUrlsResult> {
  return postJsonToOcrApi<GetFileUrlsResult>(
    "/shipment-files/signed-urls",
    {
      ...input,
      shopId,
    },
    "署名付きURL生成に失敗しました",
  );
}
