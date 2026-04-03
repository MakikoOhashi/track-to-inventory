import { data as json, type ActionFunctionArgs } from "react-router";
import { extractOcrText } from "~/lib/ocrBackend.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return json({ error: "OCR対象ファイルがありません" }, { status: 400 });
    }

    const result = await extractOcrText(file);
    return json(result);
  } catch (error) {
    console.error("OCR text extraction failed:", error);
    const message = error instanceof Error ? error.message : "OCRに失敗しました";
    return json(
      { error: message },
      { status: message.includes("not configured") ? 503 : 500 },
    );
  }
};
