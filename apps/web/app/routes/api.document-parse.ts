import { data as json, type ActionFunctionArgs } from "react-router";
import { parseDocumentFile, validateDocumentParseFile } from "~/lib/documentParse.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import {
  refundOcrOrAiUsage,
  reserveOcrOrAiUsage,
} from "~/lib/usageGateway.server";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/utils/shopDomain";

function mapValidationError(code: string, ja: boolean): { message: string; status: number } {
  if (code === "NO_FILE") {
    return {
      message: ja ? "解析対象ファイルがありません" : "No parse target file provided",
      status: 400,
    };
  }
  if (code === "EMPTY_FILE") {
    return {
      message: ja ? "空のファイルはアップロードできません" : "Empty files are not allowed",
      status: 400,
    };
  }
  if (code.startsWith("FILE_TOO_LARGE:")) {
    const size = code.slice("FILE_TOO_LARGE:".length);
    return {
      message: ja
        ? `ファイルサイズは最大10MBまでです（現在のサイズ: ${size}）`
        : `File size must be 10MB or less (current: ${size})`,
      status: 413,
    };
  }
  if (code === "UNSUPPORTED_FILE_TYPE") {
    return {
      message: ja ? "許可されていないファイル形式です" : "Unsupported file type",
      status: 415,
    };
  }
  return {
    message: ja ? "ファイル検証に失敗しました" : "File validation failed",
    status: 400,
  };
}

/**
 * Stage D: one-file document parse on Workers (no Render).
 * Shop is taken only from authenticate.admin session.
 */
export async function action({ request }: ActionFunctionArgs) {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let shop: string;
  try {
    const auth = await authenticate.admin(request);
    shop = normalizeShopDomain(auth.session.shop);
    if (!shop) {
      return json({ error: ja ? "認証に失敗しました" : "Authentication failed" }, { status: 401 });
    }
  } catch (error) {
    if (error instanceof Response) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 401;
      return json({ error: ja ? "認証に失敗しました" : "Authentication failed" }, { status: status === 403 ? 403 : 401 });
    }
    return json({ error: ja ? "認証に失敗しました" : "Authentication failed" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    const mapped = mapValidationError("NO_FILE", ja);
    return json({ error: mapped.message }, { status: mapped.status });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    const mapped = mapValidationError("NO_FILE", ja);
    return json({ error: mapped.message }, { status: mapped.status });
  }

  try {
    validateDocumentParseFile(file);
  } catch (error) {
    const code = error instanceof Error ? error.message : "NO_FILE";
    const mapped = mapValidationError(code, ja);
    return json({ error: mapped.message }, { status: mapped.status });
  }

  let operationId: string | undefined;
  try {
    const reserved = await reserveOcrOrAiUsage({ shopId: shop, kind: "ocr" });
    operationId = reserved.operationId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "OCR_LIMIT_EXCEEDED") {
      return json(
        {
          error: ja
            ? "OCR使用回数の月間上限に達しました。プランをアップグレードしてください。"
            : "You have exceeded the monthly OCR usage limit. Please upgrade your plan.",
          type: "usage_limit",
        },
        { status: 429 },
      );
    }
    return json({ error: ja ? "利用制限の確認に失敗しました" : "Failed to check usage limits" }, { status: 500 });
  }

  try {
    const parsed = await parseDocumentFile(file);
    return json({
      text: parsed.text,
      previewUrl: parsed.previewUrl,
      result: parsed.result,
    });
  } catch (error) {
    if (operationId) {
      await refundOcrOrAiUsage({ shopId: shop, kind: "ocr", operationId }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : "";
    if (/API key/i.test(message) || /GEMINI_API_KEY/i.test(message)) {
      return json(
        { error: ja ? "AI設定エラーです" : "AI configuration error" },
        { status: 503 },
      );
    }
    return json(
      { error: ja ? "書類の解析に失敗しました" : "Failed to parse document" },
      { status: 500 },
    );
  }
}
