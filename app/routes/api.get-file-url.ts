import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { authenticate } from "~/shopify.server";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Shopifyセッション認証（ページルートからの呼び出しの場合）
    let shopId: string;
    try {
      const { session } = await authenticate.admin(request);
      shopId = session.shop;
    } catch (authError) {
      // 認証に失敗した場合は、リクエストボディからshop_idを取得
      const body = await request.json();
      shopId = body.shopId;
      
      if (!shopId) {
        return json({ error: "shop_idが必要です" }, { status: 401 });
      }
    }

    const { filePaths, siNumber } = await request.json();

    console.log('Received file URL request:', { filePaths, siNumber, type: typeof filePaths, shopId });

    // 単一ファイルパスの場合も配列として処理
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    
    if (!paths.length || paths.every(path => !path)) {
      return json({ error: "ファイルパスが指定されていません" }, { status: 400 });
    }

    // SI番号による認証チェック
    if (siNumber) {
      try {
        // Supabaseクライアントを使用してshop_idを取得
        const { data, error } = await supabase
          .from('shipments')
          .select('shop_id')
          .eq('si_number', siNumber)
          .single();
        
        if (error) {
          console.error('Database query error:', error);
          return json({ error: "データベースエラー" }, { status: 500 });
        }
        
        if (!data) {
          console.error('Shipment not found:', siNumber);
          return json({ error: "ファイルが見つかりません" }, { status: 404 });
        }
        
        const fileShopId = data.shop_id;
        console.log('Shop ID comparison:', { requestShopId: shopId, fileShopId });
        
        if (fileShopId !== shopId) {
          console.error('Shop ID mismatch:', { 
            requestShopId: shopId, 
            fileShopId, 
            siNumber 
          });
          return json({ error: "アクセス権限がありません" }, { status: 403 });
        }
      } catch (dbError) {
        console.error('Database error:', dbError);
        return json({ error: "データベースエラー" }, { status: 500 });
      }
    }

    // Supabaseクライアントの初期化を確認
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing Supabase environment variables');
      return json({ error: "Supabase設定エラー" }, { status: 500 });
    }

    // 複数ファイルの署名付きURLを一括生成
    const signedUrls: Record<string, string> = {};
    const errors: string[] = [];

    for (const filePath of paths) {
      if (!filePath) continue;

      // パスのバリデーション（セキュリティ）
      if (/[\\:*?"<>|]/.test(filePath) || filePath.includes('..') || filePath.startsWith('/')) {
        console.error('Invalid file path detected:', filePath);
        errors.push(`不正なファイルパス: ${filePath}`);
        continue;
      }

      try {
        console.log('Generating signed URL for file path:', filePath);

        // Private bucket用: signed URLを生成（24時間有効に延長）
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from("shipment-files")
          .createSignedUrl(filePath, 24 * 60 * 60); // 24時間

        if (signedUrlError) {
          console.error('Signed URL generation error for', filePath, ':', signedUrlError);
          errors.push(`${filePath}: ${signedUrlError.message}`);
          continue;
        }

        if (!signedUrlData?.signedUrl) {
          console.error('No signed URL returned for:', filePath);
          errors.push(`${filePath}: 署名付きURLが生成されませんでした`);
          continue;
        }

        signedUrls[filePath] = signedUrlData.signedUrl;
        console.log('Successfully generated signed URL for:', filePath);

      } catch (error) {
        console.error('Error generating signed URL for', filePath, ':', error);
        errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 結果を返す
    const result: any = { signedUrls };
    
    if (errors.length > 0) {
      result.errors = errors;
    }

    // 単一ファイルの場合は従来の形式もサポート
    if (paths.length === 1 && paths[0]) {
      result.signedUrl = signedUrls[paths[0]];
    }

    console.log('Returning signed URLs result:', Object.keys(signedUrls));
    return json(result);

  } catch (error) {
    console.error('Error generating signed URLs:', error);
    return json({ 
      error: "ファイルURL生成中にエラーが発生しました",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}; 