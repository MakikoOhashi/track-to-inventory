import { data as json, type ActionFunctionArgs } from "react-router";
import { uploadShipmentFile } from "~/lib/ocrBackend.server";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('uploadShipmentFile API called'); // Debug log
  const ja = isJapaneseRequest(request, resolveRequestLocale(request));
  
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // FormDataを使用してファイルを取得
    const formData = await request.formData();
    console.log('FormData parsed successfully'); // Debug log

    const si_number = formData.get('si_number') as string;
    const type = formData.get('type') as string;
    const file = formData.get('file') as File;

    console.log('Extracted fields:', { 
      si_number, 
      type, 
      fileName: file?.name,
      fileSize: file?.size 
    }); // Debug log

    if (!si_number || !type || !file) {
      console.error('Missing required fields:', { 
        si_number: !!si_number, 
        type: !!type, 
        file: !!file 
      });
      return json({ error: ja ? "必須フィールドが不足しています" : "Required fields are missing" }, { status: 400 });
    }

    const result = await uploadShipmentFile({
      siNumber: si_number,
      type,
      file,
    });

    return json(result);

  } catch (error) {
    console.error('Unexpected error in uploadShipmentFile:', error);
    const message = error instanceof Error ? error.message : String(error);
    return json({ 
      error: message.includes("必須") || message.includes("空のファイル") || message.includes("最大10MB") || message.includes("許可されていない") || message.includes("不正なファイルパス")
        ? message
        : (ja ? "ファイルアップロード中にエラーが発生しました" : "An error occurred while uploading the file"),
      details: message
    }, { status: message.includes("必須") || message.includes("空のファイル") || message.includes("最大10MB") || message.includes("許可されていない") || message.includes("不正なファイルパス") ? 400 : 500 });
  }
};
