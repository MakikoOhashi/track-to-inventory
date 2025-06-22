import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { authenticate } from "~/shopify.server";
import { checkDeleteLimit, incrementDeleteCount } from "~/lib/redis.server";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const action = async ({ request }: any) => {
  console.log('=== DELETE SHIPMENT API START ===');
  console.log('Request method:', request.method);
  console.log('Request URL:', request.url);

  if (request.method !== "DELETE") {
    console.log('Method not allowed:', request.method);
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // 1. Shopify認証を実行（fallback処理付き）
    let shopId: string;
    try {
      console.log('Attempting Shopify authentication...');
      const { session } = await authenticate.admin(request);
      shopId = session.shop;
      console.log('✅ Shopify authentication successful, shopId:', shopId);
    } catch (authError) {
      console.error('❌ Shopify authentication failed:', authError);
      
      // Fallback: URLパラメータからshop情報を取得
      const url = new URL(request.url);
      const shopParam = url.searchParams.get('shop');
      
      if (shopParam) {
        shopId = shopParam;
        console.log('✅ Using shop from URL parameter:', shopId);
      } else {
        console.error('❌ No shop information available');
        return json({ 
          error: "認証に失敗しました。アプリを再インストールしてください。" 
        }, { status: 401 });
      }
    }

    const formData = await request.formData();
    const siNumber = formData.get("siNumber") as string;
    
    console.log('Form data received:', { siNumber, shopId });

    if (!siNumber) {
      console.error('❌ SI number is missing');
      return json({ error: "SI番号が必須です" }, { status: 400 });
    }

    // 2. 削除対象の存在チェック
    console.log('Checking if shipment exists...');
    const { data: existingShipment, error: checkError } = await supabase
      .from("shipments")
      .select("si_number, shop_id")
      .eq("si_number", siNumber)
      .eq("shop_id", shopId)
      .single();

    if (checkError) {
      console.error('❌ Database check error:', checkError);
      if (checkError.code === 'PGRST116') {
        return json({ error: "指定されたSI番号のデータが見つかりません" }, { status: 404 });
      }
      return json({ error: "データベースエラーが発生しました" }, { status: 500 });
    }

    if (!existingShipment) {
      console.error('❌ Shipment not found:', { siNumber, shopId });
      return json({ error: "指定されたSI番号のデータが見つかりません" }, { status: 404 });
    }

    console.log('✅ Shipment exists:', existingShipment);

    // 3. 削除回数制限チェック（削除前に実行）
    try {
      console.log('Checking delete limit...');
      await checkDeleteLimit(shopId, 2); // 2回まで
      console.log('✅ Delete limit check passed');
    } catch (limitError) {
      console.error('❌ Delete limit exceeded:', limitError);
      return json({ 
        error: "Freeプランの削除可能回数を超えました。プランをアップグレードしてください。" 
      }, { status: 403 });
    }

    // 4. 実際の削除処理
    console.log('Proceeding with deletion...');
    const { error: deleteError } = await supabase
      .from("shipments")
      .delete()
      .eq("si_number", siNumber)
      .eq("shop_id", shopId);

    if (deleteError) {
      console.error('❌ Delete operation failed:', deleteError);
      return json({ error: "データの削除に失敗しました" }, { status: 500 });
    }

    console.log('✅ Shipment deleted successfully');

    // 5. 削除成功後に回数をカウント
    try {
      await incrementDeleteCount(shopId);
      console.log('✅ Delete count incremented');
    } catch (countError) {
      console.error('⚠️ Failed to increment delete count:', countError);
      // カウントエラーは削除処理を妨げない
    }

    console.log('=== DELETE SHIPMENT API SUCCESS ===');
    return json({ success: true, message: "データを正常に削除しました" });
  } catch (error) {
    console.error('❌ DELETE SHIPMENT API ERROR:', error);
    return json({ 
      error: "サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。" 
    }, { status: 500 });
  }
};