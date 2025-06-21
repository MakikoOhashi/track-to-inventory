import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { filePath } = await request.json();

    if (!filePath) {
      return json({ error: "ファイルパスが指定されていません" }, { status: 400 });
    }

    // パスのバリデーション（セキュリティ）
    if (/[\\/:*?"<>|]/.test(filePath)) {
      return json({ error: "不正なファイルパスです" }, { status: 400 });
    }

    console.log('Generating signed URL for file path:', filePath);

    // Private bucket用: signed URLを生成（1時間有効）
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("shipment-files")
      .createSignedUrl(filePath, 60 * 60); // 1時間

    if (signedUrlError) {
      console.error('Signed URL generation error:', signedUrlError);
      return json({ 
        error: `署名付きURL生成エラー: ${signedUrlError.message}`,
        details: signedUrlError
      }, { status: 500 });
    }

    if (!signedUrlData?.signedUrl) {
      console.error('No signed URL returned from Supabase');
      return json({ error: "署名付きURLが生成されませんでした" }, { status: 500 });
    }

    console.log('Successfully generated signed URL');
    return json({ signedUrl: signedUrlData.signedUrl });

  } catch (error) {
    console.error('Error generating signed URL:', error);
    return json({ 
      error: "ファイルURL生成中にエラーが発生しました",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}; 