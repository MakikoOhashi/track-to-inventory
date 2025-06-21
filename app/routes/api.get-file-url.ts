import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { authenticate } from "~/shopify.server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Shopifyセッション認証
    const { session } = await authenticate.admin(request);
    const shopId = session.shop;

    const { filePath } = await request.json();

    console.log('Received file path request:', { filePath, type: typeof filePath, shopId });

    if (!filePath) {
      return json({ error: "ファイルパスが指定されていません" }, { status: 400 });
    }

    // パスのバリデーション（セキュリティ）- ディレクトリトラバーサル攻撃を防止
    // 許可: 英数字、ハイフン、アンダースコア、ドット、スラッシュ
    // 禁止: バックスラッシュ、特殊文字、パストラバーサル文字
    if (/[\\:*?"<>|]/.test(filePath) || filePath.includes('..') || filePath.startsWith('/')) {
      console.error('Invalid file path detected:', filePath);
      return json({ error: "不正なファイルパスです" }, { status: 400 });
    }

    // ファイルパスからshop_idを抽出して認証チェック
    const pathParts = filePath.split('/');
    console.log('File path parts:', pathParts);
    
    if (pathParts.length >= 1) {
      const siNumber = pathParts[0]; // 最初の部分がsi_number
      console.log('Extracted SI number:', siNumber);
      
      // データベースからshipment情報を取得してshop_idを確認
      try {
        const dbUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/shipments?si_number=eq.${encodeURIComponent(siNumber)}&select=shop_id`;
        console.log('Querying database:', dbUrl);
        
        const response = await fetch(dbUrl, {
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          console.log('Database response:', data);
          
          if (Array.isArray(data) && data.length > 0) {
            const fileShopId = data[0].shop_id;
            console.log('Shop ID comparison:', { requestShopId: shopId, fileShopId });
            
            if (fileShopId !== shopId) {
              console.error('Shop ID mismatch:', { 
                requestShopId: shopId, 
                fileShopId, 
                siNumber 
              });
              return json({ error: "アクセス権限がありません" }, { status: 403 });
            }
          } else {
            console.error('Shipment not found:', siNumber);
            return json({ error: "ファイルが見つかりません" }, { status: 404 });
          }
        } else {
          console.error('Database query failed:', response.status);
          return json({ error: "データベースエラー" }, { status: 500 });
        }
      } catch (dbError) {
        console.error('Database error:', dbError);
        return json({ error: "データベースエラー" }, { status: 500 });
      }
    }

    console.log('Generating signed URL for file path:', filePath);

    // Private bucket用: signed URLを生成（15分有効）
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("shipment-files")
      .createSignedUrl(filePath, 15 * 60); // 15分

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