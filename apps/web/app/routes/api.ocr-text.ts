import { data as json, type ActionFunctionArgs } from "react-router";
import { extractOcrText } from "~/lib/ocrBackend.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const ja = isJapaneseRequest(request, resolveRequestLocale(request));
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return json({ error: ja ? "OCR対象ファイルがありません" : "No OCR target file provided" }, { status: 400 });
    }

    const result = await extractOcrText(file);
    return json(result);
  } catch (error) {
    console.error("OCR text extraction failed:", error);
    const ja = isJapaneseRequest(request, resolveRequestLocale(request));
    const message = error instanceof Error ? error.message : (ja ? "OCRに失敗しました" : "OCR failed");
    return json(
      { error: message },
      { status: message.includes("not configured") ? 503 : 500 },
    );
  }
};
