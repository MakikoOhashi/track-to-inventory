import {
  ALLOWED_OCR_EXTENSIONS,
  ALLOWED_OCR_MIME_TYPES,
  MAX_UPLOAD_FILE_SIZE,
  formatFileSizeInMb,
  getFileExtension,
} from "@track-to-inventory/shared/ocr-runtime";
import { generateGeminiContent, generateGeminiMultimodalContent } from "~/lib/geminiClient";

export type DocumentParseFields = {
  si_number?: string;
  supplier_name?: string;
  transport_type?: string;
  items?: Array<{
    name?: string;
    quantity?: string | number;
    product_code?: string;
    unit_price?: string;
  }>;
  extracted_text?: string;
};

const DOCUMENT_PARSE_PROMPT = `
次のShipping Documentsから、以下の項目を推測し、各項目名・形式は必ず下記の通り返してください。
あなたは請求書・船積書類から情報を抽出するAIです。

【必ず守るルール】
- 回答は**JSONオブジェクトのみ**で返してください。自然言語、解説文、余計な出力は禁止です。
- **絶対に下記のフィールド名・形式のみで返してください**。項目名・配列名・型は変更禁止です。
- 読み取れない項目は空文字、または items は空配列にしてください。
- 事実がない値を捏造しないでください。

【出力するフィールド】
- extracted_text（文字列。文書から読み取れる主要テキストの要約または全文に近い抽出）
- si_number（文字列）
- supplier_name（文字列）
- transport_type（文字列）
- items（配列。要素は下記4つのプロパティを持つオブジェクト）
    - name（文字列、商品名または商品説明）
    - quantity（数字だけ。単位やカンマ、空白はいらない）
    - product_code（文字列。なければ空文字でOK）
    - unit_price（文字列。なければ空文字でOK）

返答例:
{
  "extracted_text": "INVOICE NO. SN13/10-0005 ...",
  "si_number": "SN13/10-0005",
  "supplier_name": "SUNPLAN SOFT CO., LTD",
  "transport_type": "NIPPON MARU",
  "items": [
    {"name": "LED1102B Chip LED Blue", "quantity": "10000", "product_code": "", "unit_price": ""},
    {"name": "LED1102G Chip LED Green", "quantity": "10000", "product_code": "", "unit_price": ""}
  ]
}
`.trim();

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function validateDocumentParseFile(file: File): string {
  if (!(file instanceof File)) {
    throw new Error("NO_FILE");
  }

  if (file.size === 0) {
    throw new Error("EMPTY_FILE");
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    throw new Error(`FILE_TOO_LARGE:${formatFileSizeInMb(file.size)}`);
  }

  const fileExt = getFileExtension(file.name);
  if (!ALLOWED_OCR_EXTENSIONS.includes(fileExt) || !ALLOWED_OCR_MIME_TYPES.includes(file.type)) {
    throw new Error("UNSUPPORTED_FILE_TYPE");
  }

  return fileExt;
}

function cleanGeminiJson(aiText: string): string {
  let cleanedJson = aiText;
  const jsonMatch = aiText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    cleanedJson = jsonMatch[1];
  }
  return cleanedJson;
}

export function normalizeDocumentParseResult(aiText: string): {
  text: string;
  result: string;
  fields: DocumentParseFields;
} {
  const cleanedJson = cleanGeminiJson(aiText);

  try {
    const parsed = JSON.parse(cleanedJson) as DocumentParseFields;
    const {
      extracted_text: extractedText,
      si_number: siNumber = "",
      supplier_name: supplierName = "",
      transport_type: transportType = "",
      items = [],
    } = parsed;

    const fields: DocumentParseFields = {
      si_number: typeof siNumber === "string" ? siNumber : "",
      supplier_name: typeof supplierName === "string" ? supplierName : "",
      transport_type: typeof transportType === "string" ? transportType : "",
      items: Array.isArray(items) ? items : [],
    };

    const result = JSON.stringify(fields);
    const text =
      typeof extractedText === "string" && extractedText.trim()
        ? extractedText
        : [
            fields.si_number && `SI: ${fields.si_number}`,
            fields.supplier_name && `Supplier: ${fields.supplier_name}`,
            fields.transport_type && `Transport: ${fields.transport_type}`,
          ]
            .filter(Boolean)
            .join("\n");

    return { text, result, fields };
  } catch {
    return { text: "", result: "{}", fields: {} };
  }
}

export async function parseDocumentFile(file: File): Promise<{
  text: string;
  result: string;
  previewUrl?: string;
}> {
  validateDocumentParseFile(file);

  const isPlainText = file.type === "text/plain" || getFileExtension(file.name) === "txt";

  let aiText: string;
  let previewUrl: string | undefined;

  if (isPlainText) {
    const textContent = await file.text();
    aiText = await generateGeminiContent(
      `${DOCUMENT_PARSE_PROMPT}\n\n原文:\n${textContent}`,
    );
  } else {
    const buffer = await file.arrayBuffer();
    const base64Data = arrayBufferToBase64(buffer);
    const mimeType = file.type || "application/octet-stream";

    if (mimeType.startsWith("image/")) {
      previewUrl = `data:${mimeType};base64,${base64Data}`;
    }

    aiText = await generateGeminiMultimodalContent({
      prompt: DOCUMENT_PARSE_PROMPT,
      mimeType,
      base64Data,
    });
  }

  const normalized = normalizeDocumentParseResult(aiText);
  return {
    text: normalized.text,
    result: normalized.result,
    previewUrl,
  };
}
