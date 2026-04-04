import { data as json, type ActionFunctionArgs } from "react-router";
import { isJapaneseRequest, resolveRequestLocale } from "~/lib/requestLocale";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const locale = resolveRequestLocale(request);
  const ja = isJapaneseRequest(request, locale);
  
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch (error) {
    return json({ error: ja ? 'JSONが不正です' : 'Invalid JSON' }, { status: 400 });
  }
  
  const { shipment } = body;
  if (!shipment) {
    return json({ error: ja ? '配送データがありません' : 'Missing shipment data' }, { status: 400 });
  }

  const url = new URL(request.url);
  const shopIdFromQuery = url.searchParams.get("shop_id") || url.searchParams.get("shopId") || "";
  const bodyShopId =
    typeof body.shop_id === 'string'
      ? body.shop_id
      : typeof body.shopId === 'string'
        ? body.shopId
        : typeof shipment.shop_id === 'string'
          ? shipment.shop_id
          : "";
  const shopId = shopIdFromQuery || bodyShopId;

  if (!shopId) {
    return json({ error: ja ? '認証に失敗しました' : 'Authentication failed', details: 'shop_id is required' }, { status: 401 });
  }

  // shop_idの検証と設定
  if (shipment.shop_id && shipment.shop_id !== shopId) {
    return json({ error: ja ? 'shop_idが一致しません' : 'Shop ID mismatch' }, { status: 403 });
  }

  // shop_idを確実に設定
  shipment.shop_id = shopId;

  // 必須フィールドの検証
  if (!shipment.si_number) {
    return json({ error: ja ? 'si_numberが必要です' : 'si_number is required' }, { status: 400 });
  }

  // Supabaseクライアントの初期化を確認
  let supabaseClient;
  try {
    supabaseClient = createSupabaseAdminClient();
  } catch (error) {
    return json({ error: ja ? 'データベース接続に失敗しました' : 'Database connection failed' }, { status: 500 });
  }

  // ファイルURLフィールドは含める（Supabaseのupsertに渡す）
  // 実際のファイルオブジェクトがあれば除外するが、URL文字列は保存対象
  const { 
    invoiceFile, 
    siFile, 
    plFile, 
    otherFile,
    created_at,
    updated_at,
    // ファイルオブジェクトとタイムスタンプフィールドを除外し、URLフィールドは保持
    ...safeData 
  } = shipment;

  // 空文字列の日付フィールドをnullに変換（PostgreSQL DATE型エラー対策）
  const cleanDateField = (value: any) => {
    if (value === '' || value === undefined) {
      return null;
    }
    return value;
  };

  // 日付フィールドをクリーンアップ
  const cleanedData = {
    ...safeData,
    eta: cleanDateField(safeData.eta),
    etd: cleanDateField(safeData.etd),
    clearance_date: cleanDateField(safeData.clearance_date),
    arrival_date: cleanDateField(safeData.arrival_date)
  };

  try {
    const { data, error } = await supabaseClient
      .from('shipments')
      .upsert([cleanedData]);

    if (error) {
      return json({ error: error.message }, { status: 500 });
    }
    return json({ data });
  } catch (error) {
    return json({ error: ja ? 'データベース操作に失敗しました' : 'Database operation failed' }, { status: 500 });
  }
};
