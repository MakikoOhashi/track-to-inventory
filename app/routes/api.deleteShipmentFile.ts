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

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { si_number, type, url } = body;
  if (!si_number || !type || !url) {
    return json({ error: "missing fields" }, { status: 400 });
  }

  try {
    // ファイルパス抽出ロジックを改善
    let filePath = "";
    
    // URLが署名付きURLの場合（token=を含む場合）
    if (url.includes('token=')) {
      try {
        const urlObj = new URL(url);
        const pathMatch = urlObj.pathname.match(/\/storage\/v1\/object\/sign\/shipment-files\/(.+)/);
        if (pathMatch) {
          filePath = pathMatch[1];
        }
      } catch (urlError) {
        console.error('URL parsing error:', urlError);
      }
    }
    
    // ファイルパスが抽出できなかった場合、従来の方法を試す
    if (!filePath) {
      const matches = url.match(/\/([^/]+)\.([a-zA-Z0-9]+)$/);
      if (matches) {
        filePath = `${si_number}/${type}.${matches[2]}`;
      }
    }
    
    // ファイルパスが特定できない場合
    if (!filePath) {
      console.error('Could not determine file path from URL:', url);
      return json({ error: "ファイルパス特定失敗" }, { status: 400 });
    }

    console.log('Deleting file path:', filePath);

    const { error } = await supabase
      .storage
      .from("shipment-files")
      .remove([filePath]);

    if (error) {
      console.error('Supabase delete error:', error);
      return json({ 
        error: `ファイル削除エラー: ${error.message}`,
        details: error
      }, { status: 500 });
    }
    
    console.log('File deleted successfully');
    return json({ ok: true });
  } catch (error) {
    console.error('Unexpected error in deleteShipmentFile:', error);
    return json({ 
      error: "ファイル削除中にエラーが発生しました",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
};