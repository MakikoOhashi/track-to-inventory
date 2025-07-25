import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from '@supabase/supabase-js';
import { authenticate } from "~/shopify.server";

// Supabaseクライアントの初期化を改善
let supabase: any = null;

function initializeSupabase() {
  if (supabase) return supabase;
  
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables');
  }
  
  supabase = createClient(supabaseUrl, supabaseKey);
  return supabase;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log('updateShipment API called'); // Debug log
  
  if (request.method !== 'POST') {
    console.log('Method not allowed:', request.method);
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Shopify認証
  let shopId: string;
  try {
    const { session } = await authenticate.admin(request);
    shopId = session.shop;
    console.log('Shopify session shop:', shopId);
  } catch (authError) {
    console.error('Shopify authentication failed:', authError);
    return json({ error: 'Authentication failed' }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
    console.log('Request body received:', body); // Debug log
  } catch (error) {
    console.error('JSON parse error:', error);
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }
  
  const { shipment } = body;
  if (!shipment) {
    console.error('Missing shipment data');
    return json({ error: 'missing shipment' }, { status: 400 });
  }

  // shop_idの検証と設定
  if (shipment.shop_id && shipment.shop_id !== shopId) {
    console.error('Shop ID mismatch:', { requestShopId: shopId, shipmentShopId: shipment.shop_id });
    return json({ error: 'Shop ID mismatch' }, { status: 403 });
  }

  // shop_idを確実に設定
  shipment.shop_id = shopId;

  // 必須フィールドの検証
  if (!shipment.si_number) {
    console.error('Missing si_number in shipment data');
    return json({ error: 'si_number is required' }, { status: 400 });
  }

  console.log('Shipment data to save:', shipment); // Debug log

  // Supabaseクライアントの初期化を確認
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('Supabase configuration:');
  console.log('- SUPABASE_URL exists:', !!supabaseUrl);
  console.log('- SUPABASE_SERVICE_ROLE_KEY exists:', !!supabaseKey);
  console.log('- SUPABASE_SERVICE_ROLE_KEY length:', supabaseKey?.length);

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase environment variables');
    return json({ error: 'Server configuration error' }, { status: 500 });
  }

  console.log('Supabase URL:', supabaseUrl); // Debug log (URLのみ)
  console.log('Supabase key exists:', !!supabaseKey); // Debug log (キーの存在のみ)

  // Supabaseクライアントの初期化
  let supabaseClient;
  try {
    supabaseClient = initializeSupabase();
    console.log('Supabase client initialized successfully');
  } catch (error) {
    console.error('Supabase initialization error:', error);
    return json({ error: 'Database connection failed' }, { status: 500 });
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

  console.log('Safe data to upsert:', cleanedData); // Debug log
  console.log('File URL fields included:', {
    invoice_url: cleanedData.invoice_url,
    si_url: cleanedData.si_url,
    pl_url: cleanedData.pl_url,
    other_url: cleanedData.other_url
  }); // Debug log

  try {
    const { data, error } = await supabaseClient
      .from('shipments')
      .upsert([cleanedData]);

    if (error) {
      console.error('Supabase upsert error:', error);
      return json({ error: error.message }, { status: 500 });
    }

    console.log('Upsert successful:', data);
    return json({ data });
  } catch (error) {
    console.error('Unexpected error in upsert:', error);
    return json({ error: 'Database operation failed' }, { status: 500 });
  }
};