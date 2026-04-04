import { data as json, type ActionFunctionArgs } from "react-router";
import { uploadShipmentFile } from "~/lib/ocrBackend.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

export const action = async ({ request }: ActionFunctionArgs) => {
  const ja = isJapaneseRequest(request, resolveRequestLocale(request));
  
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // FormDataを使用してファイルを取得
    const formData = await request.formData();

    const si_number = formData.get('si_number') as string;
    const type = formData.get('type') as string;
    const file = formData.get('file') as File;

    if (!si_number || !type || !file) {
      return json({ error: ja ? "必須フィールドが不足しています" : "Required fields are missing" }, { status: 400 });
    }

    const result = await uploadShipmentFile({
      siNumber: si_number,
      type,
      file,
    });

    return json(result);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ 
      error: message.includes("必須") || message.includes("空のファイル") || message.includes("最大10MB") || message.includes("許可されていない") || message.includes("不正なファイルパス")
        ? message
        : (ja ? "ファイルアップロード中にエラーが発生しました" : "An error occurred while uploading the file"),
      details: message
    }, { status: message.includes("必須") || message.includes("空のファイル") || message.includes("最大10MB") || message.includes("許可されていない") || message.includes("不正なファイルパス") ? 400 : 500 });
  }
};
